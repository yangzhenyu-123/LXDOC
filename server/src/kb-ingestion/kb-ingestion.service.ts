import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  KbIngestionRequest,
  IngestionRequestStatus,
} from './entities/kb-ingestion-request.entity';
import {
  KbIngestionReview,
  ReviewDecision,
} from './entities/kb-ingestion-review.entity';
import { KnowledgeBase } from '../knowledge-base/entities/knowledge-base.entity';
import { Document } from '../documents/document.entity';
import { Organization } from '../organizations/organization.entity';
import { UserOrgRole, UserOrgRoleValue } from '../organizations/user-org-role.entity';
import { UserRole } from '../users/user.entity';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';
import { NotificationService } from '../notifications/notification.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-log.entity';

/**
 * 知识库入库审核服务
 *
 * 职责：
 * 1. createRequest：判断 KB.requireReview，决定直接入库 or 创建申请
 * 2. approve：first-write-wins（DB 乐观锁），触发 kbService.addDocument 入库
 * 3. reject：仅记录意见，不强制终结
 * 4. revoke：申请人撤销
 * 5. list/find：查询
 *
 * 审核人决定（用户已确认）：
 *   - 文档 owner.ownerType=personal → 文档所有者本人即申请人，无需审核
 *   - 文档 owner.ownerType=group/department → owner 节点 + path 上溯各节点的 UserOrgRole.admin
 *   - 全局 UserRole.ADMIN 始终可审（兜底）
 *
 * 并发：
 *   - first-write-wins 用 UPDATE WHERE status='pending' 乐观锁（affected=1 抢到首通过）
 *   - 同一 (requestId, reviewerId) 唯一约束防重复审核
 *   - 同一 (kbId, documentId) 同时只允许一个 pending/approved 请求（partial unique index）
 */
@Injectable()
export class KbIngestionService {
  private readonly logger = new Logger(KbIngestionService.name);

  constructor(
    @InjectRepository(KbIngestionRequest)
    private readonly requestRepo: Repository<KbIngestionRequest>,
    @InjectRepository(KbIngestionReview)
    private readonly reviewRepo: Repository<KbIngestionReview>,
    @InjectRepository(KnowledgeBase)
    private readonly kbRepo: Repository<KnowledgeBase>,
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    @InjectRepository(UserOrgRole)
    private readonly userOrgRoleRepo: Repository<UserOrgRole>,
    private readonly kbService: KnowledgeBaseService,
    private readonly notificationService: NotificationService,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  // ========== 申请 ==========

  /**
   * 创建入库申请
   *
   * - KB.requireReview=false → 直接调用 kbService.addDocument，返回 { ingested: true, chunkCount }
   * - KB.requireReview=true  → 创建 request，向审核人群发通知，返回 { ingested: false, requestId }
   *
   * 任何登录用户可调用。校验：
   * - KB 存在
   * - 文档存在
   * - 该 (kbId, documentId) 无 pending/approved 申请（否则提示已有进行中申请）
   */
  async createRequest(input: {
    kbId: string;
    documentId: string;
    requesterId: string;
    note?: string;
  }): Promise<{ ingested: boolean; requestId?: string; chunkCount?: number }> {
    const kb = await this.kbRepo.findOne({ where: { id: input.kbId } });
    if (!kb) throw new NotFoundException(`知识库 ${input.kbId} 不存在`);

    const doc = await this.docRepo.findOne({ where: { id: input.documentId } });
    if (!doc) throw new NotFoundException(`文档 ${input.documentId} 不存在`);

    // KB 未开启审核 → 直接入库
    if (!kb.requireReview) {
      const chunkCount = await this.kbService.addDocument(input.kbId, input.documentId);
      return { ingested: true, chunkCount };
    }

    // KB 开启审核 → 检查是否已有进行中的申请
    const existing = await this.requestRepo.findOne({
      where: [
        { kbId: input.kbId, documentId: input.documentId, status: IngestionRequestStatus.PENDING },
        { kbId: input.kbId, documentId: input.documentId, status: IngestionRequestStatus.APPROVED },
      ],
    });
    if (existing) {
      throw new BadRequestException(
        `文档已存在进行中的入库申请（requestId=${existing.id}, status=${existing.status}）`,
      );
    }

    // 创建申请
    const request = this.requestRepo.create({
      kbId: input.kbId,
      documentId: input.documentId,
      requesterId: input.requesterId,
      requesterNote: input.note ?? null,
      status: IngestionRequestStatus.PENDING,
    });
    const saved = await this.requestRepo.save(request);
    this.logger.log(`创建入库申请 ${saved.id}（kb=${input.kbId}, doc=${input.documentId}）`);

    // 审计
    await this.auditService.log({
      userId: input.requesterId,
      action: AuditAction.KB_INGESTION_CREATE,
      target: { type: 'kb_ingestion_request', id: saved.id },
      detail: {
        kbId: input.kbId,
        documentId: input.documentId,
        note: input.note,
      },
    });

    // 决定审核人列表（文档 owner 组织归属）
    const reviewerIds = await this.resolveReviewers(doc);

    // 发通知（无审核人时仍创建申请，由 admin 兜底审核）
    if (reviewerIds.length > 0) {
      await this.notificationService.createBatch(
        reviewerIds
          .filter((uid) => uid !== input.requesterId) // 不通知申请人自己
          .map((uid) => ({
            userId: uid,
            type: NotificationType.KB_INGESTION_REQUEST,
            title: `入库申请：${doc.title}`,
            content: `知识库「${kb.name}」收到新文档「${doc.title}」的入库申请，请审核。`,
            payload: { requestId: saved.id, kbId: input.kbId, documentId: input.documentId },
          })),
      );
    } else {
      // 无组织 admin 时通知全局 admin（兜底）
      this.logger.warn(
        `入库申请 ${saved.id} 无组织 admin 审核人，需全局 admin 介入`,
      );
    }

    return { ingested: false, requestId: saved.id };
  }

  /**
   * 审核通过
   *
   * first-write-wins：
   * - UPDATE WHERE status='pending' → affected=1 抢到首通过，触发入库
   * - affected=0 表示已被他人通过 → 仅补录 review（isFirstApproval=false）
   *
   * 权限：审核人（resolveReviewers）或全局 admin
   */
  async approve(input: {
    requestId: string;
    reviewerId: string;
    reviewerRole: UserRole;
    comment?: string;
  }): Promise<{ firstApproval: boolean; ingested: boolean; chunkCount?: number; error?: string }> {
    const request = await this.getRequestOrThrow(input.requestId);

    // 权限校验
    await this.assertCanReview(request, input.reviewerId, input.reviewerRole);

    // 重复审核校验（同审核人不能审两次）
    const existingReview = await this.reviewRepo.findOne({
      where: { requestId: input.requestId, reviewerId: input.reviewerId },
    });
    if (existingReview) {
      throw new BadRequestException('您已审核过该申请');
    }

    // first-write-wins：乐观锁抢首通过
    // 用事务保证 review 记录 + status 更新原子性
    let isFirstApproval = false;
    let ingested = false;
    let chunkCount: number | undefined;
    let ingestError: string | undefined;

    await this.dataSource.transaction(async (manager) => {
      // 乐观锁：仅 pending 时更新
      const result = await manager.getRepository(KbIngestionRequest).update(
        { id: input.requestId, status: IngestionRequestStatus.PENDING },
        {
          status: IngestionRequestStatus.APPROVED,
          resolvedById: input.reviewerId,
          resolvedAt: new Date(),
        },
      );

      isFirstApproval = (result.affected ?? 0) > 0;

      // 写 review 记录
      const review = manager.getRepository(KbIngestionReview).create({
        requestId: input.requestId,
        reviewerId: input.reviewerId,
        decision: ReviewDecision.APPROVE,
        comment: input.comment ?? null,
        isFirstApproval,
      });
      await manager.getRepository(KbIngestionReview).save(review);
    });

    if (!isFirstApproval) {
      // 已被他人抢先通过，仅记录意见
      this.logger.log(
        `审核人 ${input.reviewerId} 补录通过意见（已由他人抢先通过）request=${input.requestId}`,
      );
      return { firstApproval: false, ingested: false };
    }

    // 首通过 → 触发入库（在事务外执行，避免长事务阻塞审核记录）
    try {
      chunkCount = await this.kbService.addDocument(request.kbId, request.documentId);
      ingested = true;
      await this.requestRepo.update(input.requestId, {
        status: IngestionRequestStatus.DONE,
        resultChunkCount: chunkCount,
        resultError: null,
      });
      this.logger.log(
        `入库申请 ${input.requestId} 通过并入库成功（chunkCount=${chunkCount}）`,
      );

      // 通知申请人：入库完成
      await this.notificationService.create({
        userId: request.requesterId,
        type: NotificationType.KB_INGESTION_DONE,
        title: '入库完成',
        content: `您的入库申请已通过审核，文档已加入知识库（生成 ${chunkCount} chunk）。`,
        payload: { requestId: input.requestId, kbId: request.kbId, documentId: request.documentId, chunkCount },
      });
    } catch (err) {
      ingestError = (err as Error).message;
      await this.requestRepo.update(input.requestId, {
        // status 保持 APPROVED，记录错误信息便于运维介入
        resultChunkCount: null,
        resultError: ingestError,
      });
      this.logger.error(
        `入库申请 ${input.requestId} 通过后入库失败：${ingestError}`,
      );
      // 通知申请人：入库失败
      await this.notificationService.create({
        userId: request.requesterId,
        type: NotificationType.KB_INGESTION_DONE,
        title: '入库失败',
        content: `您的入库申请已通过审核，但入库过程出错：${ingestError}。请联系管理员。`,
        payload: { requestId: input.requestId, kbId: request.kbId, documentId: request.documentId, error: ingestError },
      });
    }

    // 审计
    await this.auditService.log({
      userId: input.reviewerId,
      action: AuditAction.KB_INGESTION_APPROVE,
      target: { type: 'kb_ingestion_request', id: input.requestId },
      detail: {
        decision: ReviewDecision.APPROVE,
        isFirstApproval,
        kbId: request.kbId,
        documentId: request.documentId,
        chunkCount,
        error: ingestError,
      },
    });

    return { firstApproval: true, ingested, chunkCount, error: ingestError };
  }

  /**
   * 审核拒绝
   *
   * 仅记录意见，不强制终结申请（用户已确认语义）。
   * 申请人若要终结流程，需主动 revoke。
   */
  async reject(input: {
    requestId: string;
    reviewerId: string;
    reviewerRole: UserRole;
    comment?: string;
  }): Promise<{ rejected: boolean }> {
    const request = await this.getRequestOrThrow(input.requestId);

    // 权限校验
    await this.assertCanReview(request, input.reviewerId, input.reviewerRole);

    // 重复审核校验
    const existingReview = await this.reviewRepo.findOne({
      where: { requestId: input.requestId, reviewerId: input.reviewerId },
    });
    if (existingReview) {
      throw new BadRequestException('您已审核过该申请');
    }

    // 写 review 记录（不改 status）
    const review = this.reviewRepo.create({
      requestId: input.requestId,
      reviewerId: input.reviewerId,
      decision: ReviewDecision.REJECT,
      comment: input.comment ?? null,
      isFirstApproval: false,
    });
    await this.reviewRepo.save(review);
    this.logger.log(
      `审核人 ${input.reviewerId} 拒绝入库申请 ${input.requestId}（仅记录意见，不终结）`,
    );

    // 通知申请人：被拒绝
    await this.notificationService.create({
      userId: request.requesterId,
      type: NotificationType.KB_INGESTION_REJECTED,
      title: '入库申请收到拒绝意见',
      content: `审核人对您的入库申请提交了拒绝意见（申请仍保持待审，可联系其他审核人或撤销）。${input.comment ? `意见：${input.comment}` : ''}`,
      payload: { requestId: input.requestId, kbId: request.kbId, documentId: request.documentId, comment: input.comment },
    });

    // 审计
    await this.auditService.log({
      userId: input.reviewerId,
      action: AuditAction.KB_INGESTION_REJECT,
      target: { type: 'kb_ingestion_request', id: input.requestId },
      detail: {
        decision: ReviewDecision.REJECT,
        kbId: request.kbId,
        documentId: request.documentId,
        comment: input.comment,
      },
    });

    return { rejected: true };
  }

  /**
   * 申请人撤销申请
   *
   * 仅 pending 状态可撤销（approved 已触发入库，不可撤销）。
   * 撤销后置 status=revoked，并通知已审核过的审核人。
   */
  async revoke(input: {
    requestId: string;
    requesterId: string;
    reason?: string;
  }): Promise<{ revoked: boolean }> {
    const request = await this.getRequestOrThrow(input.requestId);

    // 仅申请人可撤销
    if (request.requesterId !== input.requesterId) {
      throw new ForbiddenException('仅申请人可撤销申请');
    }

    // 仅 pending 可撤销
    if (request.status !== IngestionRequestStatus.PENDING) {
      throw new BadRequestException(
        `当前状态为 ${request.status}，无法撤销（仅 pending 可撤销）`,
      );
    }

    await this.requestRepo.update(input.requestId, {
      status: IngestionRequestStatus.REVOKED,
      resolvedAt: new Date(),
    });
    this.logger.log(`申请人 ${input.requesterId} 撤销入库申请 ${input.requestId}`);

    // 通知已审核的审核人：申请已撤销
    const reviews = await this.reviewRepo.find({ where: { requestId: input.requestId } });
    const reviewerIds = [...new Set(reviews.map((r) => r.reviewerId))];
    if (reviewerIds.length > 0) {
      await this.notificationService.createBatch(
        reviewerIds.map((uid) => ({
          userId: uid,
          type: NotificationType.KB_INGESTION_REVOKED,
          title: '入库申请已撤销',
          content: `申请人已撤销入库申请。${input.reason ? `原因：${input.reason}` : ''}`,
          payload: { requestId: input.requestId, kbId: request.kbId, documentId: request.documentId },
        })),
      );
    }

    // 审计
    await this.auditService.log({
      userId: input.requesterId,
      action: AuditAction.KB_INGESTION_REVOKE,
      target: { type: 'kb_ingestion_request', id: input.requestId },
      detail: {
        action: 'revoke',
        kbId: request.kbId,
        documentId: request.documentId,
        reason: input.reason,
      },
    });

    return { revoked: true };
  }

  // ========== 查询 ==========

  /**
   * 申请详情（含审核意见列表）
   */
  async findOne(id: string): Promise<{
    request: KbIngestionRequest;
    reviews: KbIngestionReview[];
  }> {
    const request = await this.getRequestOrThrow(id);
    const reviews = await this.reviewRepo.find({
      where: { requestId: id },
      order: { createdAt: 'ASC' },
    });
    return { request, reviews };
  }

  /**
   * 列表查询（按 status / kbId / requesterId 筛选，分页）
   */
  async findAll(query: {
    status?: IngestionRequestStatus;
    kbId?: string;
    requesterId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: KbIngestionRequest[]; total: number }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const qb = this.requestRepo
      .createQueryBuilder('r')
      .orderBy('r.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (query.status) qb.andWhere('r.status = :status', { status: query.status });
    if (query.kbId) qb.andWhere('r.kbId = :kbId', { kbId: query.kbId });
    if (query.requesterId) qb.andWhere('r.requesterId = :requesterId', { requesterId: query.requesterId });

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /**
   * 列出某用户待审核的申请
   * - 全局 admin：所有 pending
   * - 组织 admin：文档 owner 在其管理范围内的 pending
   */
  async findPendingForReviewer(
    reviewerId: string,
    reviewerRole: UserRole,
    manageableOrgIds: string[],
  ): Promise<KbIngestionRequest[]> {
    const qb = this.requestRepo
      .createQueryBuilder('r')
      .where('r.status = :status', { status: IngestionRequestStatus.PENDING })
      .orderBy('r.createdAt', 'DESC');

    if (reviewerRole === UserRole.ADMIN) {
      return qb.getMany();
    }

    // 组织 admin：仅其管理范围内的文档
    if (manageableOrgIds.length === 0) {
      return [];
    }
    qb.andWhere('r.documentId IN (SELECT id FROM documents WHERE owner_id IN (:...orgIds))', {
      orgIds: manageableOrgIds,
    });
    return qb.getMany();
  }

  // ========== 内部辅助 ==========

  private async getRequestOrThrow(id: string): Promise<KbIngestionRequest> {
    const request = await this.requestRepo.findOne({ where: { id } });
    if (!request) throw new NotFoundException(`入库申请 ${id} 不存在`);
    return request;
  }

  /**
   * 校验审核权限
   * - 全局 admin 可审
   * - 文档 owner 组织 path 上溯各节点的 admin 可审
   * - personal 文档：仅 admin 可审（personal 不应进入审核流，兜底）
   */
  private async assertCanReview(
    request: KbIngestionRequest,
    reviewerId: string,
    reviewerRole: UserRole,
  ): Promise<void> {
    if (reviewerRole === UserRole.ADMIN) return;

    const doc = await this.docRepo.findOne({ where: { id: request.documentId } });
    if (!doc) {
      throw new NotFoundException(`文档 ${request.documentId} 不存在`);
    }

    const reviewerIds = await this.resolveReviewers(doc);
    if (!reviewerIds.includes(reviewerId)) {
      throw new ForbiddenException('您不是该入库申请的审核人');
    }
  }

  /**
   * 决定审核人列表
   *
   * - personal 文档：返回 []（personal 不应走审核流，KB admin 兜底）
   * - group/department 文档：owner 节点 + path 上溯各节点的 UserOrgRole.admin（去重）
   */
  async resolveReviewers(doc: Document): Promise<string[]> {
    if (!doc.ownerId) return [];
    const org = await this.orgRepo.findOne({ where: { id: doc.ownerId } });
    if (!org) return [];

    // 拆分 path 段，查所有节点的 admin
    const orgIds = org.path.split('.').filter(Boolean);
    if (orgIds.length === 0) return [];

    const roles = await this.userOrgRoleRepo.find({
      where: { orgId: In(orgIds), role: UserOrgRoleValue.ADMIN },
    });
    // 去重 reviewerId
    return [...new Set(roles.map((r) => r.userId))];
  }

  /**
   * 计算用户能审核的 org id 集合（用于 findPendingForReviewer）
   * - admin：null 表示全权
   * - 其他：用户有 admin 角色的节点 + 其子树
   */
  async getManageableOrgIds(userId: string): Promise<string[]> {
    const roles = await this.userOrgRoleRepo.find({
      where: { userId, role: UserOrgRoleValue.ADMIN },
    });
    if (roles.length === 0) return [];

    const orgIds = roles.map((r) => r.orgId);
    const orgs = await this.orgRepo.find({ where: { id: In(orgIds) } });
    const paths = orgs.map((o) => o.path);

    // 查所有 path 以这些 path 为前缀的子节点 id（admin 管理范围向下继承）
    if (paths.length === 0) return orgIds;
    const qb = this.orgRepo
      .createQueryBuilder('o')
      .select('o.id', 'id');
    // 拼接 OR 前缀条件
    paths.forEach((p, i) => {
      const cond = `o.path = :p${i} OR o.path LIKE :pl${i}`;
      qb.orWhere(cond, { [`p${i}`]: p, [`pl${i}`]: `${p}.%` });
    });
    const rows = await qb.getRawMany<{ id: string }>();
    return [...new Set([...orgIds, ...rows.map((r) => r.id)])];
  }
}

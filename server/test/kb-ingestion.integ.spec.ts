/**
 * 知识库入库审核工作流集成测试
 *
 * 覆盖端到端流程：
 * - createRequest：requireReview=false 直接入库 / =true 创建申请 + 通知审核人
 * - approve：first-write-wins + 触发入库 + done + 通知申请人
 * - reject：仅记录意见，不改 status
 * - revoke：仅 pending 可撤销
 * - partial unique index：同一 (kbId, documentId) 不允许多个活跃申请
 * - resolveReviewers：沿 org.path 上溯取 admin
 * - findPendingForReviewer：admin 全部 / 组织 admin 管理范围
 * - notification 落表
 *
 * 依赖：
 * - createTestDb（独立 schema + 真 pgvector/pg_trgm）
 * - mock EmbeddingService（确定性向量）
 * - 真 KnowledgeBaseService（chunking + embedding + 入库）
 */
import { createTestDb, TestDb } from './db-helpers';
import { createMockEmbeddingService } from './mock-embedding';
import { KbIngestionService } from '../src/kb-ingestion/kb-ingestion.service';
import { NotificationService } from '../src/notifications/notification.service';
import { KnowledgeBaseService } from '../src/knowledge-base/knowledge-base.service';
import { ChunkingService } from '../src/knowledge-base/chunking.service';
import { KbIngestionRequest, IngestionRequestStatus } from '../src/kb-ingestion/entities/kb-ingestion-request.entity';
import { KbIngestionReview, ReviewDecision } from '../src/kb-ingestion/entities/kb-ingestion-review.entity';
import { Notification } from '../src/notifications/entities/notification.entity';
import { KnowledgeBase } from '../src/knowledge-base/entities/knowledge-base.entity';
import { KbChunk } from '../src/knowledge-base/entities/kb-chunk.entity';
import { MessageFeedback } from '../src/knowledge-base/entities/message-feedback.entity';
import { Document, DocumentFormat, ContentSource, DocumentOwnerType } from '../src/documents/document.entity';
import { Organization, OrganizationType } from '../src/organizations/organization.entity';
import { UserOrgRole, UserOrgRoleValue } from '../src/organizations/user-org-role.entity';
import { AuditLog } from '../src/audit/audit-log.entity';
import { UserRole } from '../src/users/user.entity';
import { randomUUID } from 'crypto';

describe('KbIngestionService 集成测试', () => {
  let db: TestDb;
  let ingestionService: KbIngestionService;
  let notificationService: NotificationService;
  let kbService: KnowledgeBaseService;
  let embeddingService: ReturnType<typeof createMockEmbeddingService>;

  // 测试用户
  const requesterId = randomUUID();
  const groupAdminId = randomUUID();
  const deptAdminId = randomUUID();
  const otherUserId = randomUUID();
  const globalAdminId = randomUUID();

  beforeEach(async () => {
    db = await createTestDb();
    embeddingService = createMockEmbeddingService();
    const chunkingService = new ChunkingService();
    kbService = new KnowledgeBaseService(
      db.ds.getRepository(KnowledgeBase),
      db.ds.getRepository(KbChunk),
      db.ds.getRepository(Document),
      chunkingService,
      embeddingService,
      db.ds.manager,
      { isReady: () => false } as any,
    );
    notificationService = new NotificationService(db.ds.getRepository(Notification));

    // mock AuditService（不依赖 AuditLog 表的写入语义，集成测试只验证 ingestion 主流程）
    const auditService = {
      log: jest.fn().mockImplementation(async (input: any) => {
        try {
          await db.ds.getRepository(AuditLog).save({
            userId: input.userId,
            action: input.action,
            targetType: input.target?.type ?? null,
            targetId: input.target?.id ?? null,
            detail: input.detail ?? null,
          });
        } catch {
          /* 吞错 */
        }
      }),
    };

    ingestionService = new KbIngestionService(
      db.ds.getRepository(KbIngestionRequest),
      db.ds.getRepository(KbIngestionReview),
      db.ds.getRepository(KnowledgeBase),
      db.ds.getRepository(Document),
      db.ds.getRepository(Organization),
      db.ds.getRepository(UserOrgRole),
      kbService,
      notificationService,
      auditService as any,
      db.ds,
    );
  });

  afterEach(async () => {
    await db.close();
  });

  // ========== 辅助 ==========

  async function createOrgTree(): Promise<{ deptId: string; groupId: string }> {
    const deptId = randomUUID();
    const groupId = randomUUID();
    await db.ds.getRepository(Organization).save({
      id: deptId,
      parentId: null,
      name: '研发部',
      type: OrganizationType.DEPARTMENT,
      path: deptId,
      sort: 0,
    });
    await db.ds.getRepository(Organization).save({
      id: groupId,
      parentId: deptId,
      name: '前端组',
      type: OrganizationType.GROUP,
      path: `${deptId}.${groupId}`,
      sort: 0,
    });
    // 授权 admin
    await db.ds.getRepository(UserOrgRole).save({
      userId: deptAdminId,
      orgId: deptId,
      role: UserOrgRoleValue.ADMIN,
    });
    await db.ds.getRepository(UserOrgRole).save({
      userId: groupAdminId,
      orgId: groupId,
      role: UserOrgRoleValue.ADMIN,
    });
    return { deptId, groupId };
  }

  async function createKb(requireReview: boolean): Promise<string> {
    const kb = await kbService.create({
      name: `测试KB-${requireReview}`,
      requireReview,
      createdBy: globalAdminId,
    });
    return kb.id;
  }

  async function createGroupDoc(groupId: string, title: string): Promise<string> {
    const doc = await db.ds.getRepository(Document).save({
      categoryId: randomUUID(),
      title,
      content: `# ${title}\n\n正文 ${title} 测试内容足够切分。`,
      format: DocumentFormat.MD,
      contentSource: ContentSource.MANUAL,
      ownerType: DocumentOwnerType.GROUP,
      ownerId: groupId,
      createdBy: requesterId,
    });
    return doc.id;
  }

  // ========== createRequest ==========

  describe('createRequest', () => {
    it('requireReview=false 时直接入库（不创建申请）', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(false);
      const docId = await createGroupDoc(groupId, '直接入库文档');

      const result = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      expect(result.ingested).toBe(true);
      expect(result.chunkCount).toBeGreaterThan(0);

      // 不应存在申请
      const reqCount = await db.ds.getRepository(KbIngestionRequest).count();
      expect(reqCount).toBe(0);

      // chunk 应入库
      const chunkCount = await db.ds.getRepository(KbChunk).count({
        where: { kbId, documentId: docId },
      });
      expect(chunkCount).toBeGreaterThan(0);
    });

    it('requireReview=true 时创建申请并通知审核人（沿 path 上溯）', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '审核文档');

      const result = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
        note: '请审核',
      });

      expect(result.ingested).toBe(false);
      expect(result.requestId).toBeDefined();

      // 申请落表
      const req = await db.ds.getRepository(KbIngestionRequest).findOne({
        where: { id: result.requestId! },
      });
      expect(req?.status).toBe(IngestionRequestStatus.PENDING);
      expect(req?.requesterNote).toBe('请审核');

      // 通知 group admin + dept admin（不通知申请人自己）
      const notifications = await db.ds.getRepository(Notification).find();
      const userIds = notifications.map((n) => n.userId);
      expect(userIds).toContain(groupAdminId);
      expect(userIds).toContain(deptAdminId);
      expect(userIds).not.toContain(requesterId);
    });
  });

  // ========== partial unique index ==========

  describe('partial unique index', () => {
    it('同一 (kbId, documentId) 不允许重复 pending 申请', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '唯一约束文档');

      await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      // 第二次创建应抛错
      await expect(
        ingestionService.createRequest({ kbId, documentId: docId, requesterId }),
      ).rejects.toThrow(/进行中/);
    });

    it('已 done 的申请允许同 (kbId, documentId) 重新申请', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '可重新申请文档');

      const r1 = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      // 审核通过 → done
      await ingestionService.approve({
        requestId: r1.requestId!,
        reviewerId: groupAdminId,
        reviewerRole: UserRole.EDITOR,
      });

      // done 后可再次申请（重新切分）
      const r2 = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });
      expect(r2.requestId).not.toBe(r1.requestId);
    });
  });

  // ========== approve ==========

  describe('approve', () => {
    it('首通过触发入库并置 done，通知申请人', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '通过文档');

      const r = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      const result = await ingestionService.approve({
        requestId: r.requestId!,
        reviewerId: groupAdminId,
        reviewerRole: UserRole.EDITOR,
        comment: '通过',
      });

      expect(result.firstApproval).toBe(true);
      expect(result.ingested).toBe(true);
      expect(result.chunkCount).toBeGreaterThan(0);

      // 状态 → done
      const req = await db.ds.getRepository(KbIngestionRequest).findOne({
        where: { id: r.requestId! },
      });
      expect(req?.status).toBe(IngestionRequestStatus.DONE);
      expect(req?.resolvedById).toBe(groupAdminId);
      expect(req?.resultChunkCount).toBe(result.chunkCount);

      // chunk 入库
      const chunkCount = await db.ds.getRepository(KbChunk).count({
        where: { kbId, documentId: docId },
      });
      expect(chunkCount).toBeGreaterThan(0);

      // review 落表
      const reviews = await db.ds.getRepository(KbIngestionReview).find({
        where: { requestId: r.requestId! },
      });
      expect(reviews).toHaveLength(1);
      expect(reviews[0].decision).toBe(ReviewDecision.APPROVE);
      expect(reviews[0].isFirstApproval).toBe(true);

      // 通知申请人 done
      const notif = await db.ds.getRepository(Notification).findOne({
        where: { userId: requesterId, type: 'kb_ingestion_done' },
      });
      expect(notif).not.toBeNull();
    });

    it('非首通过仅补录意见，不重复入库', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '并发通过文档');

      const r = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      // 首通过：group admin
      const r1 = await ingestionService.approve({
        requestId: r.requestId!,
        reviewerId: groupAdminId,
        reviewerRole: UserRole.EDITOR,
      });
      expect(r1.firstApproval).toBe(true);

      // 第二通过：dept admin
      const r2 = await ingestionService.approve({
        requestId: r.requestId!,
        reviewerId: deptAdminId,
        reviewerRole: UserRole.EDITOR,
      });
      expect(r2.firstApproval).toBe(false);
      expect(r2.ingested).toBe(false);

      // 两条 review 落表
      const reviews = await db.ds.getRepository(KbIngestionReview).find({
        where: { requestId: r.requestId! },
      });
      expect(reviews).toHaveLength(2);
      const firstApprovals = reviews.filter((x) => x.isFirstApproval);
      expect(firstApprovals).toHaveLength(1);
    });

    it('非审核人 approve 抛 ForbiddenException', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '权限文档');

      const r = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      await expect(
        ingestionService.approve({
          requestId: r.requestId!,
          reviewerId: otherUserId,
          reviewerRole: UserRole.EDITOR,
        }),
      ).rejects.toThrow(/不是该入库申请的审核人/);
    });

    it('全局 admin 可审任意申请', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, 'admin 审核文档');

      const r = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      const result = await ingestionService.approve({
        requestId: r.requestId!,
        reviewerId: globalAdminId,
        reviewerRole: UserRole.ADMIN,
      });
      expect(result.firstApproval).toBe(true);
    });

    it('同审核人不能审两次', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '重复审核文档');

      const r = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      await ingestionService.approve({
        requestId: r.requestId!,
        reviewerId: groupAdminId,
        reviewerRole: UserRole.EDITOR,
      });

      await expect(
        ingestionService.approve({
          requestId: r.requestId!,
          reviewerId: groupAdminId,
          reviewerRole: UserRole.EDITOR,
        }),
      ).rejects.toThrow(/已审核/);
    });
  });

  // ========== reject ==========

  describe('reject', () => {
    it('拒绝仅记录意见，不改 status', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '被拒文档');

      const r = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      const result = await ingestionService.reject({
        requestId: r.requestId!,
        reviewerId: groupAdminId,
        reviewerRole: UserRole.EDITOR,
        comment: '内容不够详细',
      });
      expect(result.rejected).toBe(true);

      // 状态仍是 pending
      const req = await db.ds.getRepository(KbIngestionRequest).findOne({
        where: { id: r.requestId! },
      });
      expect(req?.status).toBe(IngestionRequestStatus.PENDING);

      // review 落表
      const reviews = await db.ds.getRepository(KbIngestionReview).find({
        where: { requestId: r.requestId! },
      });
      expect(reviews).toHaveLength(1);
      expect(reviews[0].decision).toBe(ReviewDecision.REJECT);

      // 通知申请人被拒
      const notif = await db.ds.getRepository(Notification).findOne({
        where: { userId: requesterId, type: 'kb_ingestion_rejected' },
      });
      expect(notif).not.toBeNull();
    });

    it('拒绝后仍可被另一审核人通过', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '拒绝后通过文档');

      const r = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      // group admin 拒
      await ingestionService.reject({
        requestId: r.requestId!,
        reviewerId: groupAdminId,
        reviewerRole: UserRole.EDITOR,
      });

      // dept admin 仍可通过
      const result = await ingestionService.approve({
        requestId: r.requestId!,
        reviewerId: deptAdminId,
        reviewerRole: UserRole.EDITOR,
      });
      expect(result.firstApproval).toBe(true);
      expect(result.ingested).toBe(true);
    });
  });

  // ========== revoke ==========

  describe('revoke', () => {
    it('申请人撤销 pending 申请', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '撤销文档');

      const r = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      const result = await ingestionService.revoke({
        requestId: r.requestId!,
        requesterId,
        reason: '不再需要',
      });
      expect(result.revoked).toBe(true);

      const req = await db.ds.getRepository(KbIngestionRequest).findOne({
        where: { id: r.requestId! },
      });
      expect(req?.status).toBe(IngestionRequestStatus.REVOKED);
    });

    it('非申请人撤销抛 ForbiddenException', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '非申请人撤销文档');

      const r = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      await expect(
        ingestionService.revoke({
          requestId: r.requestId!,
          requesterId: otherUserId,
        }),
      ).rejects.toThrow(/仅申请人/);
    });

    it('已 approved 不可撤销', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '已通过撤销文档');

      const r = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      await ingestionService.approve({
        requestId: r.requestId!,
        reviewerId: groupAdminId,
        reviewerRole: UserRole.EDITOR,
      });

      await expect(
        ingestionService.revoke({
          requestId: r.requestId!,
          requesterId,
        }),
      ).rejects.toThrow(/无法撤销/);
    });

    it('撤销后释放唯一约束，可重新申请', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '撤销后重申文档');

      const r1 = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });
      await ingestionService.revoke({
        requestId: r1.requestId!,
        requesterId,
      });

      // 可重新申请
      const r2 = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });
      expect(r2.requestId).not.toBe(r1.requestId);
    });
  });

  // ========== 查询 ==========

  describe('查询', () => {
    it('findOne 返回申请 + 审核意见列表', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '详情文档');

      const r = await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });
      await ingestionService.reject({
        requestId: r.requestId!,
        reviewerId: groupAdminId,
        reviewerRole: UserRole.EDITOR,
        comment: '意见1',
      });

      const detail = await ingestionService.findOne(r.requestId!);
      expect(detail.request.id).toBe(r.requestId);
      expect(detail.reviews).toHaveLength(1);
      expect(detail.reviews[0].comment).toBe('意见1');
    });

    it('findAll 按 status 筛选 + 分页', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId1 = await createGroupDoc(groupId, '分页文档1');
      const docId2 = await createGroupDoc(groupId, '分页文档2');

      await ingestionService.createRequest({ kbId, documentId: docId1, requesterId });
      const r2 = await ingestionService.createRequest({ kbId, documentId: docId2, requesterId });
      await ingestionService.approve({
        requestId: r2.requestId!,
        reviewerId: groupAdminId,
        reviewerRole: UserRole.EDITOR,
      });

      const pendingResult = await ingestionService.findAll({
        status: IngestionRequestStatus.PENDING,
      });
      expect(pendingResult.items).toHaveLength(1);
      expect(pendingResult.items[0].documentId).toBe(docId1);

      const doneResult = await ingestionService.findAll({
        status: IngestionRequestStatus.DONE,
      });
      expect(doneResult.items).toHaveLength(1);
      expect(doneResult.items[0].documentId).toBe(docId2);
    });

    it('findPendingForReviewer：admin 全部 / 组织 admin 管理范围', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '待审文档');

      await ingestionService.createRequest({ kbId, documentId: docId, requesterId });

      // 全局 admin 看全部
      const adminPending = await ingestionService.findPendingForReviewer(
        globalAdminId,
        UserRole.ADMIN,
        [],
      );
      expect(adminPending).toHaveLength(1);

      // group admin 看管理范围内
      const manageable = await ingestionService.getManageableOrgIds(groupAdminId);
      const groupAdminPending = await ingestionService.findPendingForReviewer(
        groupAdminId,
        UserRole.EDITOR,
        manageable,
      );
      expect(groupAdminPending).toHaveLength(1);

      // 其他用户无可审
      const otherPending = await ingestionService.findPendingForReviewer(
        otherUserId,
        UserRole.EDITOR,
        [],
      );
      expect(otherPending).toHaveLength(0);
    });
  });

  // ========== Notification 落表 + markRead ==========

  describe('Notification 落表', () => {
    it('创建通知后可查询 + 标记已读', async () => {
      const { groupId } = await createOrgTree();
      const kbId = await createKb(true);
      const docId = await createGroupDoc(groupId, '通知文档');

      await ingestionService.createRequest({
        kbId,
        documentId: docId,
        requesterId,
      });

      // group admin 应有 1 条未读
      const unread = await notificationService.countUnread(groupAdminId);
      expect(unread).toBe(1);

      const list = await notificationService.findAllForUser(groupAdminId);
      expect(list.items).toHaveLength(1);
      expect(list.unreadCount).toBe(1);

      // 标记已读
      const ok = await notificationService.markRead(list.items[0].id, groupAdminId);
      expect(ok).toBe(true);

      const unread2 = await notificationService.countUnread(groupAdminId);
      expect(unread2).toBe(0);
    });
  });
});

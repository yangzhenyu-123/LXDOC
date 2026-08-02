/**
 * KbIngestionService 单元测试
 *
 * 全 mock（Repository / 依赖服务），覆盖核心业务逻辑：
 * - createRequest：requireReview=false 直接入库；requireReview=true 创建申请
 * - approve：first-write-wins（UPDATE affected=1 抢首通过 / affected=0 仅补录）
 * - reject：仅记录意见，不改 status
 * - revoke：仅申请人可撤销 / 仅 pending 可撤销
 * - resolveReviewers：沿 org.path 上溯取所有 admin
 * - getManageableOrgIds：admin 角色节点 + 子树
 *
 * 不依赖 DB；用 jest.mock 替换 typeorm Repository 与下游服务。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { KbIngestionService } from './kb-ingestion.service';
import { KbIngestionRequest, IngestionRequestStatus } from './entities/kb-ingestion-request.entity';
import { KbIngestionReview, ReviewDecision } from './entities/kb-ingestion-review.entity';
import { KnowledgeBase } from '../knowledge-base/entities/knowledge-base.entity';
import { Document, DocumentOwnerType } from '../documents/document.entity';
import { Organization, OrganizationType } from '../organizations/organization.entity';
import { UserOrgRole, UserOrgRoleValue } from '../organizations/user-org-role.entity';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';
import { NotificationService } from '../notifications/notification.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService } from '../organizations/access-control.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../users/user.entity';
import { randomUUID } from 'crypto';

// 构造测试用 AuthUser（admin 角色，S2 修复后 createRequest 需 user 做读权限校验）
const mockUser: AuthUser = {
  id: 'u1',
  role: UserRole.ADMIN,
  username: 'tester',
  organizationId: null,
  orgPath: null,
};

// helper：构造 mock repository（带链式 QB）
function mockRepo<T>() {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getMany: jest.fn().mockResolvedValue([]),
  };
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((x: T) => x as T),
    save: jest.fn(async (x: T) => ({ ...x, id: randomUUID() } as T)),
    update: jest.fn(async () => ({ affected: 1, raw: {} })),
    count: jest.fn(async () => 0),
    createQueryBuilder: jest.fn(() => qb),
    _qb: qb,
  } as any;
}

describe('KbIngestionService', () => {
  let service: KbIngestionService;
  let requestRepo: ReturnType<typeof mockRepo>;
  let reviewRepo: ReturnType<typeof mockRepo>;
  let kbRepo: ReturnType<typeof mockRepo>;
  let docRepo: ReturnType<typeof mockRepo>;
  let orgRepo: ReturnType<typeof mockRepo>;
  let userOrgRoleRepo: ReturnType<typeof mockRepo>;
  let kbService: { addDocument: jest.Mock };
  let notificationService: { create: jest.Mock; createBatch: jest.Mock };
  let auditService: { log: jest.Mock };
  let accessControl: { assertCanRead: jest.Mock; assertCanManage: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    requestRepo = mockRepo();
    reviewRepo = mockRepo();
    kbRepo = mockRepo();
    docRepo = mockRepo();
    orgRepo = mockRepo();
    userOrgRoleRepo = mockRepo();
    kbService = { addDocument: jest.fn() };
    notificationService = { create: jest.fn().mockResolvedValue(null), createBatch: jest.fn().mockResolvedValue(undefined) };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    accessControl = {
      assertCanRead: jest.fn(),
      assertCanManage: jest.fn(),
    };
    dataSource = { transaction: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KbIngestionService,
        { provide: getRepositoryToken(KbIngestionRequest), useValue: requestRepo },
        { provide: getRepositoryToken(KbIngestionReview), useValue: reviewRepo },
        { provide: getRepositoryToken(KnowledgeBase), useValue: kbRepo },
        { provide: getRepositoryToken(Document), useValue: docRepo },
        { provide: getRepositoryToken(Organization), useValue: orgRepo },
        { provide: getRepositoryToken(UserOrgRole), useValue: userOrgRoleRepo },
        { provide: KnowledgeBaseService, useValue: kbService },
        { provide: NotificationService, useValue: notificationService },
        { provide: AuditService, useValue: auditService },
        { provide: AccessControlService, useValue: accessControl },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(KbIngestionService);
  });

  // ========== createRequest ==========

  describe('createRequest', () => {
    it('KB.requireReview=false 时直接入库', async () => {
      kbRepo.findOne.mockResolvedValue({ id: 'kb1', requireReview: false, name: 'KB' });
      docRepo.findOne.mockResolvedValue({ id: 'doc1', title: 'D1' });
      kbService.addDocument.mockResolvedValue(7);

      const result = await service.createRequest({
        kbId: 'kb1',
        documentId: 'doc1',
        requesterId: 'u1',
        user: mockUser,
      });

      expect(result).toEqual({ ingested: true, chunkCount: 7 });
      expect(kbService.addDocument).toHaveBeenCalledWith('kb1', 'doc1');
      expect(requestRepo.save).not.toHaveBeenCalled();
    });

    it('KB.requireReview=true 时创建申请并通知审核人', async () => {
      const deptId = randomUUID();
      const groupId = randomUUID();
      const adminId = randomUUID();
      const requesterId = randomUUID();
      kbRepo.findOne.mockResolvedValue({ id: 'kb1', requireReview: true, name: 'KB' });
      docRepo.findOne.mockResolvedValue({
        id: 'doc1',
        title: 'D1',
        ownerType: DocumentOwnerType.GROUP,
        ownerId: groupId,
      });
      // existing 检查返回 null
      requestRepo.findOne.mockResolvedValue(null);
      // resolveReviewers：org.path 上溯查 admin
      orgRepo.findOne.mockResolvedValue({
        id: groupId,
        path: `${deptId}.${groupId}`,
        type: OrganizationType.GROUP,
      });
      userOrgRoleRepo.find.mockResolvedValue([
        { userId: adminId, orgId: groupId, role: UserOrgRoleValue.ADMIN },
      ]);

      const result = await service.createRequest({
        kbId: 'kb1',
        documentId: 'doc1',
        requesterId,
        note: '请审',
        user: mockUser,
      });

      expect(result.ingested).toBe(false);
      expect(result.requestId).toBeDefined();
      expect(requestRepo.save).toHaveBeenCalled();
      expect(notificationService.createBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ userId: adminId, type: 'kb_ingestion_request' }),
        ]),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'kb_ingestion_create' }),
      );
    });

    it('已存在 pending 申请时抛 BadRequestException', async () => {
      kbRepo.findOne.mockResolvedValue({ id: 'kb1', requireReview: true, name: 'KB' });
      docRepo.findOne.mockResolvedValue({ id: 'doc1', title: 'D1' });
      requestRepo.findOne.mockResolvedValue({ id: 'old', status: 'pending' });

      await expect(
        service.createRequest({ kbId: 'kb1', documentId: 'doc1', requesterId: 'u1', user: mockUser }),
      ).rejects.toThrow(/进行中/);
    });

    it('KB 不存在时抛 NotFoundException', async () => {
      kbRepo.findOne.mockResolvedValue(null);
      await expect(
        service.createRequest({ kbId: 'x', documentId: 'd', requesterId: 'u', user: mockUser }),
      ).rejects.toThrow(/不存在/);
    });

    it('文档不存在时抛 NotFoundException', async () => {
      kbRepo.findOne.mockResolvedValue({ id: 'kb1', requireReview: true, name: 'KB' });
      docRepo.findOne.mockResolvedValue(null);
      await expect(
        service.createRequest({ kbId: 'kb1', documentId: 'd', requesterId: 'u', user: mockUser }),
      ).rejects.toThrow(/不存在/);
    });
  });

  // ========== approve ==========

  describe('approve', () => {
    it('首通过触发入库并落 done', async () => {
      const req = {
        id: 'r1',
        kbId: 'kb1',
        documentId: 'doc1',
        requesterId: 'u-req',
        status: IngestionRequestStatus.PENDING,
      };
      requestRepo.findOne.mockResolvedValue(req);
      // assertCanReview：doc + resolveReviewers
      docRepo.findOne.mockResolvedValue({
        id: 'doc1',
        ownerType: DocumentOwnerType.GROUP,
        ownerId: 'g1',
      });
      orgRepo.findOne.mockResolvedValue({ id: 'g1', path: 'd1.g1' });
      userOrgRoleRepo.find.mockResolvedValue([
        { userId: 'u-rev', orgId: 'g1', role: UserOrgRoleValue.ADMIN },
      ]);
      reviewRepo.findOne.mockResolvedValue(null); // 无重复审核
      // transaction 内 update affected=1
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const mgr = {
          getRepository: (token: any) => ({
            update: jest.fn(async () => ({ affected: 1, raw: {} })),
            save: jest.fn(async (x: any) => x),
            create: jest.fn((x: any) => x),
          }),
        };
        return cb(mgr);
      });
      kbService.addDocument.mockResolvedValue(5);

      const result = await service.approve({
        requestId: 'r1',
        reviewerId: 'u-rev',
        reviewerRole: UserRole.EDITOR,
        comment: '通过',
      });

      expect(result.firstApproval).toBe(true);
      expect(result.ingested).toBe(true);
      expect(result.chunkCount).toBe(5);
      expect(requestRepo.update).toHaveBeenCalledWith('r1', expect.objectContaining({
        status: IngestionRequestStatus.DONE,
        resultChunkCount: 5,
      }));
      expect(notificationService.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u-req', type: 'kb_ingestion_done' }),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'kb_ingestion_approve' }),
      );
    });

    it('非首通过仅补录意见，不触发入库', async () => {
      const req = {
        id: 'r1',
        kbId: 'kb1',
        documentId: 'doc1',
        requesterId: 'u-req',
        status: IngestionRequestStatus.APPROVED,
      };
      requestRepo.findOne.mockResolvedValue(req);
      docRepo.findOne.mockResolvedValue({
        id: 'doc1',
        ownerType: DocumentOwnerType.GROUP,
        ownerId: 'g1',
      });
      orgRepo.findOne.mockResolvedValue({ id: 'g1', path: 'd1.g1' });
      userOrgRoleRepo.find.mockResolvedValue([
        { userId: 'u-rev', orgId: 'g1', role: UserOrgRoleValue.ADMIN },
      ]);
      reviewRepo.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const mgr = {
          getRepository: () => ({
            update: jest.fn(async () => ({ affected: 0, raw: {} })), // 已被他人通过
            save: jest.fn(async (x: any) => x),
            create: jest.fn((x: any) => x),
          }),
        };
        return cb(mgr);
      });

      const result = await service.approve({
        requestId: 'r1',
        reviewerId: 'u-rev',
        reviewerRole: UserRole.EDITOR,
      });

      expect(result.firstApproval).toBe(false);
      expect(result.ingested).toBe(false);
      expect(kbService.addDocument).not.toHaveBeenCalled();
      expect(requestRepo.update).not.toHaveBeenCalled();
    });

    it('全局 admin 直接通过审核，无需 resolveReviewers', async () => {
      const req = {
        id: 'r1',
        kbId: 'kb1',
        documentId: 'doc1',
        requesterId: 'u-req',
        status: IngestionRequestStatus.PENDING,
      };
      requestRepo.findOne.mockResolvedValue(req);
      reviewRepo.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const mgr = {
          getRepository: () => ({
            update: jest.fn(async () => ({ affected: 1, raw: {} })),
            save: jest.fn(async (x: any) => x),
            create: jest.fn((x: any) => x),
          }),
        };
        return cb(mgr);
      });
      kbService.addDocument.mockResolvedValue(3);

      // admin 不查 doc/org/userOrgRole
      const result = await service.approve({
        requestId: 'r1',
        reviewerId: 'u-admin',
        reviewerRole: UserRole.ADMIN,
      });

      expect(result.firstApproval).toBe(true);
      expect(docRepo.findOne).not.toHaveBeenCalled();
      expect(orgRepo.findOne).not.toHaveBeenCalled();
    });

    it('已审核过时抛 BadRequestException', async () => {
      const req = {
        id: 'r1',
        kbId: 'kb1',
        documentId: 'doc1',
        requesterId: 'u-req',
        status: IngestionRequestStatus.PENDING,
      };
      requestRepo.findOne.mockResolvedValue(req);
      reviewRepo.findOne.mockResolvedValue({ id: 'rev1', reviewerId: 'u-rev' });

      await expect(
        service.approve({
          requestId: 'r1',
          reviewerId: 'u-rev',
          reviewerRole: UserRole.ADMIN,
        }),
      ).rejects.toThrow(/已审核/);
    });

    it('入库失败时记录错误并通知申请人', async () => {
      const req = {
        id: 'r1',
        kbId: 'kb1',
        documentId: 'doc1',
        requesterId: 'u-req',
        status: IngestionRequestStatus.PENDING,
      };
      requestRepo.findOne.mockResolvedValue(req);
      reviewRepo.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const mgr = {
          getRepository: () => ({
            update: jest.fn(async () => ({ affected: 1, raw: {} })),
            save: jest.fn(async (x: any) => x),
            create: jest.fn((x: any) => x),
          }),
        };
        return cb(mgr);
      });
      kbService.addDocument.mockRejectedValue(new Error('embedding 服务超时'));

      const result = await service.approve({
        requestId: 'r1',
        reviewerId: 'u-admin',
        reviewerRole: UserRole.ADMIN,
      });

      expect(result.firstApproval).toBe(true);
      expect(result.ingested).toBe(false);
      expect(result.error).toBe('embedding 服务超时');
      expect(requestRepo.update).toHaveBeenCalledWith('r1', expect.objectContaining({
        resultError: 'embedding 服务超时',
      }));
    });
  });

  // ========== reject ==========

  describe('reject', () => {
    it('拒绝仅记录意见，不改 status', async () => {
      const req = {
        id: 'r1',
        kbId: 'kb1',
        documentId: 'doc1',
        requesterId: 'u-req',
        status: IngestionRequestStatus.PENDING,
      };
      requestRepo.findOne.mockResolvedValue(req);
      docRepo.findOne.mockResolvedValue({
        id: 'doc1',
        ownerType: DocumentOwnerType.GROUP,
        ownerId: 'g1',
      });
      orgRepo.findOne.mockResolvedValue({ id: 'g1', path: 'd1.g1' });
      userOrgRoleRepo.find.mockResolvedValue([
        { userId: 'u-rev', orgId: 'g1', role: UserOrgRoleValue.ADMIN },
      ]);
      reviewRepo.findOne.mockResolvedValue(null);
      reviewRepo.save.mockResolvedValue({ id: 'rev1' });

      const result = await service.reject({
        requestId: 'r1',
        reviewerId: 'u-rev',
        reviewerRole: UserRole.EDITOR,
        comment: '内容需要补充',
      });

      expect(result.rejected).toBe(true);
      expect(requestRepo.update).not.toHaveBeenCalled();
      expect(reviewRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'r1',
          decision: ReviewDecision.REJECT,
          comment: '内容需要补充',
        }),
      );
      expect(notificationService.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u-req', type: 'kb_ingestion_rejected' }),
      );
    });
  });

  // ========== revoke ==========

  describe('revoke', () => {
    it('申请人撤销 pending 申请', async () => {
      const req = {
        id: 'r1',
        kbId: 'kb1',
        documentId: 'doc1',
        requesterId: 'u-req',
        status: IngestionRequestStatus.PENDING,
      };
      requestRepo.findOne.mockResolvedValue(req);
      reviewRepo.find.mockResolvedValue([
        { reviewerId: 'u-rev1' },
        { reviewerId: 'u-rev2' },
      ]);
      requestRepo.update.mockResolvedValue({ affected: 1, raw: {} });

      const result = await service.revoke({
        requestId: 'r1',
        requesterId: 'u-req',
        reason: '不再需要',
      });

      expect(result.revoked).toBe(true);
      expect(requestRepo.update).toHaveBeenCalledWith('r1', expect.objectContaining({
        status: IngestionRequestStatus.REVOKED,
      }));
      expect(notificationService.createBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ userId: 'u-rev1', type: 'kb_ingestion_revoked' }),
          expect.objectContaining({ userId: 'u-rev2', type: 'kb_ingestion_revoked' }),
        ]),
      );
    });

    it('非申请人撤销时抛 ForbiddenException', async () => {
      requestRepo.findOne.mockResolvedValue({
        id: 'r1',
        requesterId: 'u-req',
        status: IngestionRequestStatus.PENDING,
      });
      await expect(
        service.revoke({ requestId: 'r1', requesterId: 'u-other' }),
      ).rejects.toThrow(/仅申请人/);
    });

    it('非 pending 状态撤销时抛 BadRequestException', async () => {
      requestRepo.findOne.mockResolvedValue({
        id: 'r1',
        requesterId: 'u-req',
        status: IngestionRequestStatus.APPROVED,
      });
      await expect(
        service.revoke({ requestId: 'r1', requesterId: 'u-req' }),
      ).rejects.toThrow(/无法撤销/);
    });
  });

  // ========== resolveReviewers ==========

  describe('resolveReviewers', () => {
    it('沿 org.path 上溯取所有 admin（去重）', async () => {
      const deptId = randomUUID();
      const groupId = randomUUID();
      const deptAdmin = randomUUID();
      const groupAdmin = randomUUID();
      const doc = {
        id: 'doc1',
        ownerType: DocumentOwnerType.GROUP,
        ownerId: groupId,
      } as Document;
      orgRepo.findOne.mockResolvedValue({
        id: groupId,
        path: `${deptId}.${groupId}`,
      });
      userOrgRoleRepo.find.mockImplementation((args: any) => {
        // args.where.orgId.In 是数组；模拟返回对应 admin
        const ids: string[] = args.where.orgId.value;
        const result: any[] = [];
        if (ids.includes(deptId)) result.push({ userId: deptAdmin, orgId: deptId });
        if (ids.includes(groupId)) result.push({ userId: groupAdmin, orgId: groupId });
        // 模拟同一用户在两个节点都有 admin 角色（去重场景）
        if (ids.includes(deptId) && ids.includes(groupId)) {
          result.push({ userId: deptAdmin, orgId: groupId });
        }
        return Promise.resolve(result);
      });

      const reviewers = await service.resolveReviewers(doc);
      // deptAdmin 应只出现一次（去重）
      expect(reviewers).toContain(deptAdmin);
      expect(reviewers).toContain(groupAdmin);
      expect(reviewers.filter((x) => x === deptAdmin)).toHaveLength(1);
    });

    it('personal 文档无 ownerId 返回空', async () => {
      const doc = { id: 'doc1', ownerType: DocumentOwnerType.PERSONAL, ownerId: null } as Document;
      const reviewers = await service.resolveReviewers(doc);
      expect(reviewers).toEqual([]);
    });

    it('org 不存在时返回空', async () => {
      const doc = { id: 'doc1', ownerType: DocumentOwnerType.GROUP, ownerId: 'x' } as Document;
      orgRepo.findOne.mockResolvedValue(null);
      const reviewers = await service.resolveReviewers(doc);
      expect(reviewers).toEqual([]);
    });
  });

  // ========== getManageableOrgIds ==========

  describe('getManageableOrgIds', () => {
    it('admin 角色节点 + 子树', async () => {
      const deptId = randomUUID();
      const groupId = randomUUID();
      userOrgRoleRepo.find.mockResolvedValue([
        { userId: 'u1', orgId: deptId, role: UserOrgRoleValue.ADMIN },
      ]);
      orgRepo.find.mockResolvedValue([{ id: deptId, path: deptId }]);
      // 子树查询
      orgRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ id: groupId }]),
      });

      const ids = await service.getManageableOrgIds('u1');
      expect(ids).toContain(deptId);
      expect(ids).toContain(groupId);
    });

    it('无 admin 角色返回空', async () => {
      userOrgRoleRepo.find.mockResolvedValue([]);
      const ids = await service.getManageableOrgIds('u1');
      expect(ids).toEqual([]);
    });
  });
});

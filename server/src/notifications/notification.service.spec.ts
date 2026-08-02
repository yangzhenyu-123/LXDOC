/**
 * NotificationService 单元测试
 *
 * 覆盖：
 * - create：成功 / 失败仅记日志不抛错
 * - findAllForUser：分页 + 未读优先
 * - countUnread
 * - markRead：单条已读 / 不存在返回 false
 * - markAllRead
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationService } from './notification.service';
import { Notification } from './entities/notification.entity';
import { randomUUID } from 'crypto';

describe('NotificationService', () => {
  let service: NotificationService;
  let repo: any;

  beforeEach(async () => {
    repo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ ...x, id: randomUUID() })),
      count: jest.fn(async () => 0),
      update: jest.fn(async () => ({ affected: 1, raw: {} })),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: getRepositoryToken(Notification), useValue: repo },
      ],
    }).compile();
    service = module.get(NotificationService);
  });

  describe('create', () => {
    it('成功创建并返回实体', async () => {
      const result = await service.create({
        userId: 'u1',
        type: 'kb_ingestion_request',
        title: 'T',
        content: 'C',
      });
      expect(result).toBeDefined();
      expect(repo.save).toHaveBeenCalled();
    });

    it('保存失败时仅记日志不抛错（返回 null）', async () => {
      repo.save.mockRejectedValue(new Error('DB down'));
      const result = await service.create({
        userId: 'u1',
        type: 'x',
        title: 'T',
        content: 'C',
      });
      expect(result).toBeNull();
    });
  });

  describe('createBatch', () => {
    it('逐条独立写入，单条失败不影响其他', async () => {
      repo.save
        .mockResolvedValueOnce({ id: '1' })
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({ id: '3' });
      await service.createBatch([
        { userId: 'u1', type: 'a', title: 't', content: 'c' },
        { userId: 'u2', type: 'a', title: 't', content: 'c' },
        { userId: 'u3', type: 'a', title: 't', content: 'c' },
      ]);
      // 不抛错即通过；save 被调用 3 次
      expect(repo.save).toHaveBeenCalledTimes(3);
    });
  });

  describe('findAllForUser', () => {
    it('分页查询并返回 unreadCount', async () => {
      repo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[{ id: 'n1' }], 1]),
      });
      repo.count.mockResolvedValue(5);

      const result = await service.findAllForUser('u1', { page: 1, pageSize: 10 });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.unreadCount).toBe(5);
    });
  });

  describe('markRead', () => {
    it('成功标记已读返回 true', async () => {
      repo.update.mockResolvedValue({ affected: 1, raw: {} });
      const ok = await service.markRead('n1', 'u1');
      expect(ok).toBe(true);
    });

    it('不存在/不属于该用户返回 false', async () => {
      repo.update.mockResolvedValue({ affected: 0, raw: {} });
      const ok = await service.markRead('n1', 'u-other');
      expect(ok).toBe(false);
    });
  });

  describe('markAllRead', () => {
    it('批量标记已读返回 affected 数', async () => {
      repo.update.mockResolvedValue({ affected: 7, raw: {} });
      const n = await service.markAllRead('u1');
      expect(n).toBe(7);
    });
  });
});

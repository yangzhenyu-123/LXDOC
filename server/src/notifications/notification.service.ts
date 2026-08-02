import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';

/**
 * 站内通知服务
 *
 * 设计：异步写入，失败仅记日志不抛错（与 AuditService 一致），
 *      避免通知失败影响审核主流程。
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
  ) {}

  /**
   * 创建一条通知（不抛错，失败仅记日志）
   */
  async create(input: {
    userId: string;
    type: string;
    title: string;
    content: string;
    payload?: Record<string, any> | null;
  }): Promise<Notification | null> {
    try {
      const row = this.notificationRepo.create({
        userId: input.userId,
        type: input.type,
        title: input.title,
        content: input.content,
        payload: input.payload ?? null,
        readAt: null,
      });
      return await this.notificationRepo.save(row);
    } catch (err) {
      this.logger.error(
        `写入通知失败 type=${input.type} userId=${input.userId}：${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * 批量创建通知（向多个审核人/申请人发通知）
   * 逐条独立写入，单条失败不影响其他。
   */
  async createBatch(
    items: Array<{
      userId: string;
      type: string;
      title: string;
      content: string;
      payload?: Record<string, any> | null;
    }>,
  ): Promise<void> {
    for (const item of items) {
      await this.create(item);
    }
  }

  /**
   * 列出某用户的通知（未读在前，按 createdAt DESC）
   */
  async findAllForUser(
    userId: string,
    options?: { onlyUnread?: boolean; page?: number; pageSize?: number },
  ): Promise<{ items: Notification[]; total: number; unreadCount: number }> {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options?.pageSize ?? 20));

    const qb = this.notificationRepo
      .createQueryBuilder('n')
      .where('n.userId = :userId', { userId })
      .orderBy('CASE WHEN n.readAt IS NULL THEN 0 ELSE 1 END', 'ASC')
      .addOrderBy('n.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [items, total] = await qb.getManyAndCount();
    const unreadCount = await this.countUnread(userId);
    return { items, total, unreadCount };
  }

  /**
   * 统计未读数
   */
  async countUnread(userId: string): Promise<number> {
    return this.notificationRepo.count({
      where: { userId, readAt: IsNull() },
    });
  }

  /**
   * 标记单条已读（需校验 userId 归属）
   * @returns 是否成功（不存在/不属于该用户返回 false）
   */
  async markRead(id: string, userId: string): Promise<boolean> {
    const result = await this.notificationRepo.update(
      { id, userId, readAt: IsNull() },
      { readAt: new Date() },
    );
    return (result.affected ?? 0) > 0;
  }

  /**
   * 全部标记已读
   */
  async markAllRead(userId: string): Promise<number> {
    const result = await this.notificationRepo.update(
      { userId, readAt: IsNull() },
      { readAt: new Date() },
    );
    return result.affected ?? 0;
  }
}

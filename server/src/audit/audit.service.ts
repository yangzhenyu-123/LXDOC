import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction, AuditLog } from './audit-log.entity';

/**
 * 审计日志写入接口入参
 * - target：操作对象（type + id），如 { type: 'document', id: '<uuid>' }
 *   id 允许为 null（登录/登出等无具体对象 id 的动作）
 * - detail：附加详情，存 jsonb
 * - req：从请求中提取的 ip / userAgent
 */
export interface AuditLogInput {
  userId: string | null;
  action: AuditAction;
  target?: { type: string; id: string | null };
  detail?: Record<string, any>;
  req?: { ip?: string; userAgent?: string };
}

/**
 * 审计日志服务
 * - log：异步写入，失败仅记日志不抛错，避免影响主流程
 * - findAll：阶段五实现分页查询
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {}

  /**
   * 写入一条审计日志
   * 任何异常都吞掉，仅记录到 logger，不阻断业务流程
   */
  async log(input: AuditLogInput): Promise<void> {
    try {
      await this.auditLogRepo.save(
        this.auditLogRepo.create({
          userId: input.userId,
          action: input.action,
          targetType: input.target?.type ?? null,
          targetId: input.target?.id ?? null,
          detail: input.detail ?? null,
          ip: input.req?.ip ?? null,
          userAgent: input.req?.userAgent ?? null,
        }),
      );
    } catch (err) {
      this.logger.error(
        `写入审计日志失败 action=${input.action}：${(err as Error).message}`,
      );
    }
  }

  /**
   * 审计日志列表查询（分页 + 按 userId / action / 时间范围筛选）
   * - page 默认 1，最小 1
   * - pageSize 默认 20，最小 1，最大 100
   * - 按 createdAt DESC 排序
   */
  async findAll(query: {
    userId?: string;
    action?: AuditAction;
    startDate?: string;
    endDate?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: AuditLog[]; total: number }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const qb = this.auditLogRepo
      .createQueryBuilder('a')
      .orderBy('a.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (query.userId) {
      qb.andWhere('a.userId = :userId', { userId: query.userId });
    }
    if (query.action) {
      qb.andWhere('a.action = :action', { action: query.action });
    }
    if (query.startDate) {
      qb.andWhere('a.createdAt >= :startDate', {
        startDate: new Date(query.startDate),
      });
    }
    if (query.endDate) {
      qb.andWhere('a.createdAt <= :endDate', {
        endDate: new Date(query.endDate),
      });
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }
}

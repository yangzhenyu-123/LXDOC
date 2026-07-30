import { SetMetadata } from '@nestjs/common';
import { AuditAction } from '../../audit/audit-log.entity';

/**
 * 标记接口需要记录审计日志的 metadata key
 * 由 AuditInterceptor 读取，决定是否在 handler 执行后写入审计日志
 */
export const AUDIT_KEY = 'audit:action';

/**
 * @Audit() 装饰器
 * 标注在 controller 方法上，表示该方法执行成功后需要记录一条审计日志
 * @param action 审计动作（对应 AuditAction 枚举）
 * @param targetType 操作对象类型（如 'document' / 'category' / 'user'），可空
 * 需配合全局 AuditInterceptor 使用（AppModule 注册为 APP_INTERCEPTOR 后生效）
 */
export const Audit = (action: AuditAction, targetType?: string) =>
  SetMetadata(AUDIT_KEY, { action, targetType });

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tap, catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { AuditAction } from './audit-log.entity';
import { AuditService } from './audit.service';
import { AUDIT_KEY } from '../common/decorators/audit.decorator';

/**
 * 审计日志拦截器
 * 全局注册为 APP_INTERCEPTOR，对带 @Audit() 装饰器的 controller 方法：
 * 1. 通过 Reflector 读取 AUDIT_KEY 元数据，无则直接放行
 * 2. 执行 handler 拿到结果
 * 3. 异步调用 auditService.log(...) 写日志（fire-and-forget，不阻塞响应、不抛错影响主流程）
 * 4. 从 req 取：req.user?.id（userId，登录接口可能无 user）、req.ip、req.headers['user-agent']
 * 5. target：从 req.params.id 或返回值 result.id 取
 * 6. detail：{ method, path, params, body: stripSensitive(req.body) }
 *    stripSensitive 移除 password/oldPassword/newPassword/refreshToken 等敏感字段
 * 7. try/catch 包裹，失败仅 logger.error
 * 8. 返回 handler 原始结果
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const meta = this.reflector.getAllAndOverride<{
      action: AuditAction;
      targetType?: string;
    }>(AUDIT_KEY, [context.getHandler(), context.getClass()]);

    // 未标注 @Audit() 的方法直接放行
    if (!meta) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest();

    // 抽取审计写入逻辑，成功/失败均记录（失败用于追溯越权尝试、暴力破解等）
    const writeAudit = (result: any, error?: any) => {
      try {
        const userId = req.user?.id ?? null;
        // 优先从路径参数取 id，其次从返回值取 id（如 POST /uploads 返回 { id }）
        const targetId = req.params?.id ?? result?.id ?? null;

        let target: { type: string; id: string | null } | undefined;
        if (meta.targetType) {
          target = { type: meta.targetType, id: targetId };
        } else if (targetId) {
          target = { type: 'unknown', id: targetId };
        }

        const detail: Record<string, any> = {
          method: req.method,
          path: req.url,
          params: req.params,
          body: this.stripSensitive(req.body),
        };
        if (error) {
          // 失败时记录错误信息（status/message），便于排查越权/暴力破解等
          detail.success = false;
          detail.errorStatus = error?.status ?? null;
          detail.errorMessage =
            error?.message ?? String(error ?? 'unknown error');
        } else {
          detail.success = true;
        }

        // fire-and-forget：不 await，失败在 service 内部已 try/catch
        this.auditService
          .log({
            userId,
            action: meta.action,
            target,
            detail,
            req: { ip: req.ip, userAgent: req.headers['user-agent'] },
          })
          .catch((err) => {
            this.logger.error(
              `审计日志写入失败 action=${meta.action}：${(err as Error).message}`,
            );
          });
      } catch (err) {
        // 兜底：同步异常也不影响响应
        this.logger.error(
          `审计拦截器处理异常 action=${meta.action}：${(err as Error).message}`,
        );
      }
    };

    // 成功：tap 记录；失败：catchError 记录后再原样抛出，不改变错误响应
    return next.handle().pipe(
      tap((result) => writeAudit(result)),
      catchError((err) => {
        writeAudit(null, err);
        return throwError(() => err);
      }),
    );
  }

  /**
   * 移除请求体中的敏感字段，避免密码 / token 明文落库到审计详情
   */
  private stripSensitive(body: any): any {
    if (!body || typeof body !== 'object') {
      return body;
    }
    const { password, oldPassword, newPassword, refreshToken, ...rest } = body;
    return rest;
  }
}

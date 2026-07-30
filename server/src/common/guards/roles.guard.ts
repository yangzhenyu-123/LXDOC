import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserRole } from '../../users/user.entity';

/**
 * 角色守卫
 * - 配合 @Roles() 装饰器：未标注或空集合直接放行
 * - 已标注角色集合时，校验 req.user.role 是否在集合中
 * - 未认证（req.user 为空）抛 ForbiddenException
 * 与全局 JwtAuthGuard 配合：JwtAuthGuard 先认证写入 req.user，RolesGuard 再做授权
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }
    const req = context.switchToHttp().getRequest();
    const user = req.user as { id: string; role: UserRole } | undefined;
    if (!user) {
      throw new ForbiddenException('未认证');
    }
    if (!required.includes(user.role)) {
      throw new ForbiddenException(
        `当前角色 ${user.role} 无权访问此资源`,
      );
    }
    return true;
  }
}

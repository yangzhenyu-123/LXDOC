import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../users/user.entity';

/**
 * 标记接口允许访问的角色 metadata key
 */
export const ROLES_KEY = 'roles';

/**
 * @Roles() 装饰器
 * 标注在 controller 方法或类上，表示允许访问的角色集合
 * 需配合 RolesGuard 使用（阶段三全局注册 APP_GUARD 后生效）
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

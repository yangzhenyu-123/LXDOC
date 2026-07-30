import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * 鉴权后挂到 req.user 上的用户信息结构
 */
export interface AuthUser {
  id: string;
  role: string;
}

/**
 * @CurrentUser() 参数装饰器
 * 从 req.user 中取出当前登录用户
 * - @CurrentUser() → 返回完整 AuthUser 对象
 * - @CurrentUser('id') → 仅返回 user.id
 * 阶段三接入全局 JwtAuthGuard 后，req.user 由 JwtStrategy.validate 写入
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as AuthUser | undefined;
    return data ? user?.[data] : user;
  },
);

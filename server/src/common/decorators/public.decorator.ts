import { SetMetadata } from '@nestjs/common';

/**
 * 标记接口为公开（无需鉴权）的 metadata key
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * @Public() 装饰器
 * 标注在 controller 方法或类上，表示该接口不需要 JWT 鉴权
 * 需配合 JwtAuthGuard 使用（阶段三全局注册 APP_GUARD 后生效）
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

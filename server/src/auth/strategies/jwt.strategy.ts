import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import {
  authConfig,
  ACCESS_TOKEN_COOKIE,
} from '../../config/auth.config';

/**
 * JWT 策略
 * - 优先从 httpOnly cookie 提取 access token（H8：前端无 JS 可读，防 XSS 窃取）
 * - 回退到 Authorization: Bearer <token>（兼容 Swagger / 外部 API 客户端）
 * - 校验签名与过期时间
 * - 拒绝 refresh token 访问业务 API
 * validate 返回值会被挂到 req.user 上，供 @CurrentUser / 守卫使用
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: any) => req?.cookies?.[ACCESS_TOKEN_COOKIE] ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: authConfig.jwtSecret,
    });
  }

  async validate(payload: any) {
    // payload: { sub, role, organizationId?, orgPath?, type? }
    // refresh token / file token 不能用于访问业务 API：
    // - refresh token：仅用于换取新 access token
    // - file token：仅用于 /api/files/:docId/...?token= 访问文件，scope 仅限单文档，
    //   若放行会被当作低权限 access token 冒充用户（role 为 undefined）
    if (payload.type === 'refresh') {
      throw new UnauthorizedException('不能使用 refresh token 访问 API');
    }
    if (payload.type === 'file') {
      throw new UnauthorizedException('不能使用文件 token 访问业务 API');
    }
    return {
      id: payload.sub,
      role: payload.role,
      username: payload.username ?? null,
      organizationId: payload.organizationId ?? null,
      orgPath: payload.orgPath ?? null,
    };
  }
}

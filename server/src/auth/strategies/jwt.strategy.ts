import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { authConfig } from '../../config/auth.config';

/**
 * JWT 策略
 * - 从 Authorization: Bearer <token> 提取 access token
 * - 校验签名与过期时间
 * - 拒绝 refresh token 访问业务 API
 * validate 返回值会被挂到 req.user 上，供 @CurrentUser / 守卫使用
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: authConfig.jwtSecret,
    });
  }

  async validate(payload: any) {
    // payload: { sub, role, organizationId?, orgPath?, type? }
    // refresh token 不能用于访问业务 API
    if (payload.type === 'refresh') {
      throw new UnauthorizedException('不能使用 refresh token 访问 API');
    }
    return {
      id: payload.sub,
      role: payload.role,
      organizationId: payload.organizationId ?? null,
      orgPath: payload.orgPath ?? null,
    };
  }
}

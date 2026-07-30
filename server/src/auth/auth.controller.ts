import {
  Body,
  Controller,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { AuditAction } from '../audit/audit-log.entity';

/**
 * 认证控制器
 * 路由前缀 auth（全局前缀 /api 生效，最终 /api/auth/...）
 * - POST   /api/auth/login           登录，返回双 token（公开）
 * - POST   /api/auth/register        自注册（受 ALLOW_SIGNUP 控制，公开）
 * - POST   /api/auth/refresh         用 refresh token 换新 access token（公开）
 * - POST   /api/auth/logout          登出，使指定 refresh token 失效（公开）
 * - PATCH  /api/auth/change-password 修改密码（需登录，依赖全局 JwtAuthGuard）
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Audit(AuditAction.LOGIN)
  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Audit(AuditAction.USER_CREATE)
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @Audit(AuditAction.LOGOUT)
  @Post('logout')
  async logout(@Body() dto: RefreshDto) {
    return this.authService.logout(dto.refreshToken);
  }

  // 不加 @Public()，依赖全局 JwtAuthGuard 校验登录态
  @Audit(AuditAction.USER_UPDATE, 'user')
  @Patch('change-password')
  async changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(userId, dto);
  }
}

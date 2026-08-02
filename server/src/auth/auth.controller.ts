import {
  Body,
  Controller,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { AuditAction } from '../audit/audit-log.entity';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  accessTokenCookieOptions,
  refreshTokenCookieOptions,
} from '../config/auth.config';

/**
 * 认证控制器
 * 路由前缀 auth（全局前缀 /api 生效，最终 /api/auth/...）
 * - POST   /api/auth/login           登录，设置 httpOnly cookie（H8）+ 返回双 token 兼容旧客户端
 * - POST   /api/auth/register        自注册（受 ALLOW_SIGNUP 控制）
 * - POST   /api/auth/refresh         用 refresh token 换新 access token（cookie 优先，body 回退）
 * - POST   /api/auth/logout          登出，清除 cookie + 使指定 refresh token 失效
 * - PATCH  /api/auth/change-password 修改密码（需登录，依赖全局 JwtAuthGuard）
 *
 * H8 修复：access/refresh token 改 httpOnly cookie 存储，前端 JS 无法读取，防 XSS 窃取。
 * 响应体仍返回 token 以兼容 Swagger / 外部 API 客户端（用 Authorization 头）；
 * SPA 前端忽略响应体中的 token，依赖 cookie 自动携带。
 */
@ApiTags('认证 Auth')
@ApiBearerAuth('access-token')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Audit(AuditAction.LOGIN)
  @ApiOperation({ summary: '登录，设置 httpOnly cookie 并返回双 token（公开）' })
  @ApiBody({ type: LoginDto })
  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return result;
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Audit(AuditAction.USER_CREATE)
  @ApiOperation({ summary: '用户自注册（公开，无需鉴权）' })
  @ApiBody({ type: RegisterDto })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(dto);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return result;
  }

  @Public()
  @ApiOperation({ summary: '刷新 access token（cookie 优先，body 回退）' })
  @ApiBody({ type: RefreshDto })
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // H8：refresh token 优先从 httpOnly cookie 读取，回退到 body（兼容旧客户端）
    const refreshToken =
      (req.cookies as Record<string, string> | undefined)?.[REFRESH_TOKEN_COOKIE] ??
      dto.refreshToken;
    if (!refreshToken) {
      throw new UnauthorizedException('refresh token 无效');
    }
    const result = await this.authService.refresh(refreshToken);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return result;
  }

  @Public()
  @Audit(AuditAction.LOGOUT)
  @ApiOperation({ summary: '登出，清除 cookie 并使指定 refresh token 失效' })
  @ApiBody({ type: RefreshDto })
  @Post('logout')
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken =
      (req.cookies as Record<string, string> | undefined)?.[REFRESH_TOKEN_COOKIE] ??
      dto.refreshToken;
    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }
    this.clearAuthCookies(res);
    return { success: true };
  }

  // 不加 @Public()，依赖全局 JwtAuthGuard 校验登录态
  @Audit(AuditAction.USER_UPDATE, 'user')
  @ApiOperation({ summary: '修改密码' })
  @ApiBody({ type: ChangePasswordDto })
  @Patch('change-password')
  async changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(userId, dto);
  }

  // ========== H8 cookie 工具方法 ==========

  private setAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
  ): void {
    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, accessTokenCookieOptions);
    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, refreshTokenCookieOptions);
  }

  private clearAuthCookies(res: Response): void {
    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });
  }
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { authConfig } from '../config/auth.config';
import { User, UserRole, UserStatus } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/**
 * 鉴权后返回给前端的用户信息（不含 passwordHash）
 */
export type SafeUser = Pick<
  User,
  'id' | 'email' | 'username' | 'role' | 'status' | 'organizationId'
>;

/**
 * 用户的组织上下文：所属组织 id 与物化路径（用于 JWT 与权限判断）
 */
interface OrgContext {
  organizationId: string | null;
  orgPath: string | null;
}

/**
 * 登录成功返回结构
 */
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: SafeUser;
}

/**
 * 认证服务
 * - login：邮箱+密码校验，签发双 token
 * - refresh：用 refresh token 换新 access token
 * - logout：使指定 refresh token 失效
 * - register：受 ALLOW_SIGNUP 开关控制的自注册
 * - changePassword：校验旧密码后更新，并清空该用户所有 refresh token
 *
 * MVP 阶段 refresh token 存内存 Map（key=userId, value=有效 refresh token 集合），
 * 不引入 Redis；服务重启后所有 refresh token 失效，需重新登录。
 */
@Injectable()
export class AuthService {
  // 内存存储：userId → 该用户当前有效的 refresh token 集合
  private readonly refreshTokens: Map<string, Set<string>> = new Map();

  constructor(
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 解析用户的组织上下文：organizationId + orgPath
   * 用户无 organizationId 或组织已被删除时返回 null/null，不阻断登录
   */
  private async resolveOrgContext(user: User): Promise<OrgContext> {
    if (!user.organizationId) {
      return { organizationId: null, orgPath: null };
    }
    const org = await this.organizationsService.findByIdOrNull(
      user.organizationId,
    );
    if (!org) {
      return { organizationId: null, orgPath: null };
    }
    return { organizationId: org.id, orgPath: org.path };
  }

  /**
   * 登录：校验邮箱+密码，签发 access + refresh token
   * 用户不存在与密码错误返回同一错误信息，避免枚举用户
   */
  async login(dto: LoginDto): Promise<LoginResult> {
    // 取出 passwordHash 用于校验
    const user = await this.usersService.findByEmail(dto.email, true);
    if (!user) {
      throw new UnauthorizedException('凭据无效');
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('凭据无效');
    }

    // 账户被禁用
    if (user.status === UserStatus.DISABLED) {
      throw new UnauthorizedException('账户已被禁用');
    }

    const orgContext = await this.resolveOrgContext(user);
    const accessToken = this.signAccessToken(user, orgContext);
    const refreshToken = this.signRefreshToken(user);

    // 存入内存 Map，便于后续 logout / refresh 校验
    const set = this.refreshTokens.get(user.id);
    if (set) {
      set.add(refreshToken);
    } else {
      this.refreshTokens.set(user.id, new Set([refreshToken]));
    }

    return { accessToken, refreshToken, user: this.toSafeUser(user) };
  }

  /**
   * 刷新：用 refresh token 换新的 access token
   * - 校验签名与有效期
   * - 校验 type=refresh
   * - 校验该 token 仍在内存集合中（未被 logout）
   * 不重发 refresh token
   */
  async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    let payload: any;
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: authConfig.jwtSecret,
      });
    } catch {
      throw new UnauthorizedException('refresh token 无效');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('refresh token 无效');
    }

    // 校验该 token 是否仍在有效集合中
    const set = this.refreshTokens.get(payload.sub);
    if (!set || !set.has(refreshToken)) {
      throw new UnauthorizedException('refresh token 已失效');
    }

    // 重新取出用户信息以签发 access token（保证 role 等最新）
    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('refresh token 无效');
    }
    if (user.status === UserStatus.DISABLED) {
      throw new UnauthorizedException('账户已被禁用');
    }

    const orgContext = await this.resolveOrgContext(user);
    const accessToken = this.signAccessToken(user, orgContext);
    return { accessToken };
  }

  /**
   * 登出：从内存集合中移除指定 refresh token
   * 不校验过期（过期也允许 logout），仅 decode 取 userId
   */
  async logout(refreshToken: string): Promise<{ success: boolean }> {
    const payload = this.jwtService.decode(refreshToken) as any;
    if (payload?.sub) {
      const set = this.refreshTokens.get(payload.sub);
      if (set) {
        set.delete(refreshToken);
        // 集合空了顺便清理 Map 条目，避免内存泄漏
        if (set.size === 0) {
          this.refreshTokens.delete(payload.sub);
        }
      }
    }
    return { success: true };
  }

  /**
   * 自注册：受 ALLOW_SIGNUP 开关控制
   * 新用户默认 role=viewer, status=active
   * 注册成功后直接返回登录态
   */
  async register(dto: RegisterDto): Promise<LoginResult> {
    if (!authConfig.allowSignup) {
      throw new ForbiddenException('自注册已关闭');
    }

    // email 唯一性校验
    const existsByEmail = await this.usersService.findByEmail(dto.email);
    if (existsByEmail) {
      throw new BadRequestException('email 已被占用');
    }

    // username 唯一性校验
    const existsByUsername = await this.usersService.findByUsername(dto.username);
    if (existsByUsername) {
      throw new BadRequestException('用户名已被占用');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    await this.usersService.createUser({
      email: dto.email,
      username: dto.username,
      passwordHash,
      role: UserRole.VIEWER,
      status: UserStatus.ACTIVE,
    });

    // 注册成功直接登录
    return this.login({ email: dto.email, password: dto.password });
  }

  /**
   * 修改密码：校验旧密码后更新，并清空该用户所有 refresh token
   * 修改成功后用户需用新密码重新登录
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<{ success: boolean }> {
    // 取出 passwordHash 用于校验旧密码
    const user = await this.usersService.findById(userId, true);
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

    const ok = await bcrypt.compare(dto.oldPassword, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('旧密码错误');
    }

    const newHash = await bcrypt.hash(dto.newPassword, 10);
    await this.usersService.updatePasswordHash(userId, newHash);

    // 清空该用户所有 refresh token，强制重新登录
    this.refreshTokens.delete(userId);

    return { success: true };
  }

  /**
   * 签发 access token
   * payload: { sub: userId, role, organizationId, orgPath }，有效期 jwtAccessExpires
   * 组织上下文用于读权限的前缀匹配；编辑授权由 AccessControlService 请求时即时查询
   */
  private signAccessToken(user: User, orgContext: OrgContext): string {
    return this.jwtService.sign(
      {
        sub: user.id,
        role: user.role,
        organizationId: orgContext.organizationId,
        orgPath: orgContext.orgPath,
      },
      {
        secret: authConfig.jwtSecret,
        expiresIn: authConfig.jwtAccessExpires,
      },
    );
  }

  /**
   * 签发 refresh token
   * payload: { sub: userId, type: 'refresh' }，有效期 jwtRefreshExpires
   * 不含 role，仅用于换取新 access token
   */
  private signRefreshToken(user: User): string {
    return this.jwtService.sign(
      { sub: user.id, type: 'refresh' },
      {
        secret: authConfig.jwtSecret,
        expiresIn: authConfig.jwtRefreshExpires,
      },
    );
  }

  /**
   * 返回不含 passwordHash 的安全用户对象
   */
  private toSafeUser(user: User): SafeUser {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      status: user.status,
      organizationId: user.organizationId,
    };
  }
}

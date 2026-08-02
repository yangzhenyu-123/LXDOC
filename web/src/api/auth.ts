import client from './client';

// 用户角色，与后端 UserRole 枚举对齐
export type UserRole = 'admin' | 'editor' | 'viewer';

// 用户状态，与后端 UserStatus 枚举对齐
export type UserStatus = 'active' | 'disabled';

// 登录用户信息
export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  // 所属组织节点 id（全局 admin 或未分配组织时为 null）
  organizationId: string | null;
}

// 登录/注册响应
// H8 修复：access/refresh token 改 httpOnly cookie，响应体中的 token 字段保留以兼容旧客户端，
// SPA 前端不再读取/存储 token，仅消费 user。cookie 由后端 Set-Cookie 自动写入。
export interface LoginResponse {
  accessToken?: string;
  refreshToken?: string;
  user: AuthUser;
}

// 刷新令牌响应
// 后端 refresh 采用轮换：每次返回新的 access + 新的 refresh（旧 refresh 立即失效）
// H8：token 通过 cookie 自动轮换，响应体字段保留以兼容旧客户端，SPA 忽略
export interface RefreshResponse {
  accessToken?: string;
  refreshToken?: string;
}

// 注册请求体
export interface RegisterDto {
  email: string;
  username: string;
  password: string;
}

/**
 * 登录
 * POST /auth/login
 * H8：token 经 httpOnly cookie 下发，前端仅消费 user
 */
export function loginApi(
  email: string,
  password: string,
): Promise<LoginResponse> {
  return client.post<LoginResponse, LoginResponse>('/auth/login', {
    email,
    password,
  });
}

/**
 * 注册（受 ALLOW_SIGNUP 控制）
 * POST /auth/register
 */
export function registerApi(dto: RegisterDto): Promise<LoginResponse> {
  return client.post<LoginResponse, LoginResponse>('/auth/register', dto);
}

/**
 * 刷新令牌
 * POST /auth/refresh
 * H8：refresh token 由 httpOnly cookie 自动携带，无需前端传参
 */
export function refreshApi(): Promise<RefreshResponse> {
  return client.post<RefreshResponse, RefreshResponse>('/auth/refresh');
}

/**
 * 登出
 * POST /auth/logout
 * H8：refresh token 由 httpOnly cookie 自动携带，无需前端传参；后端清除 cookie
 */
export function logoutApi(): Promise<void> {
  return client.post('/auth/logout');
}

/**
 * 修改密码
 * PATCH /auth/change-password
 */
export function changePasswordApi(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  return client.patch('/auth/change-password', { oldPassword, newPassword });
}

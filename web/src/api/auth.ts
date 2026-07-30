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
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

// 刷新令牌响应
export interface RefreshResponse {
  accessToken: string;
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
 */
export function refreshApi(refreshToken: string): Promise<RefreshResponse> {
  return client.post<RefreshResponse, RefreshResponse>('/auth/refresh', {
    refreshToken,
  });
}

/**
 * 登出
 * POST /auth/logout
 */
export function logoutApi(refreshToken: string): Promise<void> {
  return client.post('/auth/logout', { refreshToken });
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

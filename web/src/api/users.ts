import client from './client';
import type { UserRole, UserStatus } from './auth';

// 用户列表项，与后端用户实体对齐
export interface UserItem {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  // 所属组织节点 id（通常指向某个 group，null 表示未分配）
  organizationId: string | null;
  createdAt: string;
  updatedAt: string;
}

// 列表响应
export interface UserListResponse {
  items: UserItem[];
  total: number;
}

// 创建用户请求体
export interface CreateUserDto {
  email: string;
  username: string;
  password: string;
  role: string;
}

// 更新用户请求体
export interface UpdateUserDto {
  username?: string;
  role?: string;
  status?: string;
  // 所属组织节点 id，传 null 表示清除归属
  organizationId?: string | null;
}

/**
 * 列出用户（管理员）
 * GET /users?page=&pageSize=
 */
export function listUsersApi(
  page: number,
  pageSize: number,
): Promise<UserListResponse> {
  return client.get<UserListResponse, UserListResponse>('/users', {
    params: { page, pageSize },
  });
}

/**
 * 创建用户（管理员）
 * POST /users
 */
export function createUserApi(dto: CreateUserDto): Promise<UserItem> {
  return client.post<UserItem, UserItem>('/users', dto);
}

/**
 * 更新用户（管理员）
 * PATCH /users/:id
 */
export function updateUserApi(
  id: string,
  dto: UpdateUserDto,
): Promise<UserItem> {
  return client.patch<UserItem, UserItem>(`/users/${id}`, dto);
}

/**
 * 删除用户（管理员）
 * DELETE /users/:id
 */
export function deleteUserApi(id: string): Promise<void> {
  return client.delete(`/users/${id}`);
}

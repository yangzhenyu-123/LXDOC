import client from './client';

// 组织节点类型
export type OrganizationType = 'department' | 'group';
// 组织成员角色
export type OrgMemberRole = 'editor' | 'admin';

// 组织节点
export interface Organization {
  id: string;
  parentId: string | null;
  name: string;
  type: OrganizationType;
  path: string;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

// 成员授权（含用户基本信息）
export interface OrgMember {
  id: string;
  userId: string;
  orgId: string;
  role: OrgMemberRole;
  createdAt: string;
  username: string;
  email: string;
}

// 创建节点请求
export interface CreateOrganizationPayload {
  type: OrganizationType;
  name: string;
  parentId?: string | null;
  sort?: number;
}

// 更新节点请求
export interface UpdateOrganizationPayload {
  name?: string;
  sort?: number;
}

/**
 * 获取组织树（扁平列表，前端构建树）
 * GET /organizations
 */
export function listOrganizations(): Promise<Organization[]> {
  return client.get<Organization[], Organization[]>('/organizations');
}

/**
 * 新建组织节点
 * POST /organizations
 */
export function createOrganization(
  payload: CreateOrganizationPayload,
): Promise<Organization> {
  return client.post<Organization, Organization>('/organizations', payload);
}

/**
 * 改名 / 排序
 * PATCH /organizations/:id
 */
export function updateOrganization(
  id: string,
  payload: UpdateOrganizationPayload,
): Promise<Organization> {
  return client.patch<Organization, Organization>(
    `/organizations/${id}`,
    payload,
  );
}

/**
 * 删除节点（无子节点无文档）
 * DELETE /organizations/:id
 */
export function deleteOrganization(id: string): Promise<void> {
  return client.delete<void, void>(`/organizations/${id}`);
}

/**
 * 成员列表
 * GET /organizations/:id/members
 */
export function listMembers(orgId: string): Promise<OrgMember[]> {
  return client.get<OrgMember[], OrgMember[]>(`/organizations/${orgId}/members`);
}

/**
 * 添加成员
 * POST /organizations/:id/members
 */
export function addMember(
  orgId: string,
  userId: string,
  role: OrgMemberRole,
): Promise<OrgMember> {
  return client.post<OrgMember, OrgMember>(`/organizations/${orgId}/members`, {
    userId,
    role,
  });
}

/**
 * 改成员角色
 * PATCH /organizations/:id/members/:userId
 */
export function updateMemberRole(
  orgId: string,
  userId: string,
  role: OrgMemberRole,
): Promise<OrgMember> {
  return client.patch<OrgMember, OrgMember>(
    `/organizations/${orgId}/members/${userId}`,
    { role },
  );
}

/**
 * 移除成员
 * DELETE /organizations/:id/members/:userId
 */
export function removeMember(orgId: string, userId: string): Promise<void> {
  return client.delete<void, void>(
    `/organizations/${orgId}/members/${userId}`,
  );
}

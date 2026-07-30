import client from './client';

// 审计日志项，与后端 AuditLog 实体对齐
export interface AuditItem {
  id: string;
  userId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: any;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

// 审计列表响应
export interface AuditListResponse {
  items: AuditItem[];
  total: number;
  page: number;
  pageSize: number;
}

// 审计查询参数
export interface AuditQuery {
  userId?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

// AuditAction 枚举（与后端对齐）
export const AUDIT_ACTIONS = [
  'login',
  'logout',
  'document_create',
  'document_update',
  'document_delete',
  'category_create',
  'category_delete',
  'user_create',
  'user_update',
  'user_delete',
  'permission_change',
] as const;

/**
 * 查询审计日志（管理员）
 * GET /audit?userId=&action=&startDate=&endDate=&page=&pageSize=
 */
export function listAuditApi(
  query: AuditQuery,
): Promise<AuditListResponse> {
  return client.get<AuditListResponse, AuditListResponse>('/audit', {
    params: query,
  });
}

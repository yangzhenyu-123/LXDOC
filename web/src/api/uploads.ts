import client from './client';
import type { Document } from './documents';

// 文档归属类型，与后端 DocumentOwnerType 枚举对齐
export type DocumentOwnerType = 'personal' | 'group' | 'department';

// 文档上传响应
export interface UploadDocumentResponse {
  id: string;
  title: string;
  format: Document['format'];
  version: number;
  categoryId: string;
  ownerType: DocumentOwnerType;
  ownerId: string | null;
  isCollection?: boolean;
}

// 图片上传响应
export interface UploadImageResponse {
  url: string;
  filename: string;
}

// 创建文档集响应（与上传文档响应同构）
export type CreateCollectionResponse = UploadDocumentResponse;

/**
 * 上传单个文档
 * POST /uploads，FormData：file + categoryId [+ ownerType + ownerId] [+ isCollection]
 */
export function uploadDocument(
  file: File,
  categoryId: string,
  owner?: { type: DocumentOwnerType; id?: string | null },
  isCollection = false,
): Promise<UploadDocumentResponse> {
  const form = new FormData();
  form.append('file', file);
  form.append('categoryId', categoryId);
  if (owner?.type) {
    form.append('ownerType', owner.type);
    if (owner.type !== 'personal' && owner.id) {
      form.append('ownerId', owner.id);
    }
  }
  if (isCollection) {
    form.append('isCollection', 'true');
  }
  return client.post<UploadDocumentResponse, UploadDocumentResponse>(
    '/uploads',
    form,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
    },
  );
}

/**
 * 创建文档集（无文件，引用成员文档）
 * POST /uploads/collection，body：{ title, categoryId, memberDocIds[], [ownerType], [ownerId] }
 */
export function createCollection(
  title: string,
  categoryId: string,
  memberDocIds: string[],
  owner?: { type: DocumentOwnerType; id?: string | null },
): Promise<CreateCollectionResponse> {
  const body: Record<string, unknown> = {
    title,
    categoryId,
    memberDocIds,
  };
  if (owner?.type) {
    body.ownerType = owner.type;
    if (owner.type !== 'personal' && owner.id) {
      body.ownerId = owner.id;
    }
  }
  return client.post<CreateCollectionResponse, CreateCollectionResponse>(
    '/uploads/collection',
    body,
  );
}

/**
 * 上传图片
 * POST /uploads/image，docId 可为空（落到 temp 目录）
 */
export function uploadImage(
  file: File,
  docId?: string,
): Promise<UploadImageResponse> {
  const form = new FormData();
  form.append('file', file);
  if (docId) {
    form.append('docId', docId);
  }
  return client.post<UploadImageResponse, UploadImageResponse>(
    '/uploads/image',
    form,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
    },
  );
}

import client from './client';
import type { Document } from './documents';

// 文档上传响应
export interface UploadDocumentResponse {
  id: string;
  title: string;
  format: Document['format'];
  version: number;
  categoryId: string;
}

// 图片上传响应
export interface UploadImageResponse {
  url: string;
  filename: string;
}

/**
 * 上传文档
 * POST /uploads，使用 FormData，字段名 'file' + 'categoryId'
 */
export function uploadDocument(
  file: File,
  categoryId: string,
): Promise<UploadDocumentResponse> {
  const form = new FormData();
  form.append('file', file);
  form.append('categoryId', categoryId);
  return client.post<UploadDocumentResponse, UploadDocumentResponse>(
    '/uploads',
    form,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
    },
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

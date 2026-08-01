import client from './client';

// 附件类型，与后端 AttachmentType 枚举对齐
export type AttachmentType = 'file' | 'document';

// 附件实体（与后端 DocumentAttachment 对齐）
export interface DocumentAttachment {
  id: string;
  documentId: string;
  attachType: AttachmentType;
  name: string;
  filePath: string | null;
  fileSize: number | null;
  fileExt: string | null;
  linkedDocumentId: string | null;
  sort: number;
  createdBy: string | null;
  createdAt: string;
}

/**
 * 列出文档的附件（含集合共享附件聚合）
 * GET /documents/:docId/attachments
 */
export function listAttachments(
  docId: string,
): Promise<DocumentAttachment[]> {
  return client.get<DocumentAttachment[], DocumentAttachment[]>(
    `/documents/${docId}/attachments`,
  );
}

/**
 * 上传附件文件（file 类型）
 * POST /documents/:docId/attachments/file，FormData：file [+ sort query]
 */
export function uploadAttachmentFile(
  docId: string,
  file: File,
  sort?: number,
): Promise<DocumentAttachment> {
  const form = new FormData();
  form.append('file', file);
  const params = sort !== undefined ? { sort: String(sort) } : undefined;
  return client.post<DocumentAttachment, DocumentAttachment>(
    `/documents/${docId}/attachments/file`,
    form,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      params,
    },
  );
}

/**
 * 把另一个文档引用为集合成员（document 类型）
 * POST /documents/:docId/attachments/document，body：{ linkedDocumentId, sort? }
 */
export function linkDocumentToCollection(
  docId: string,
  linkedDocumentId: string,
  sort?: number,
): Promise<DocumentAttachment> {
  const body: Record<string, unknown> = { linkedDocumentId };
  if (sort !== undefined) body.sort = sort;
  return client.post<DocumentAttachment, DocumentAttachment>(
    `/documents/${docId}/attachments/document`,
    body,
  );
}

/**
 * 删除附件 / 移出集合
 * DELETE /documents/:docId/attachments/:attachId
 */
export function deleteAttachment(
  docId: string,
  attachId: string,
): Promise<{ success: boolean }> {
  return client.delete<{ success: boolean }, { success: boolean }>(
    `/documents/${docId}/attachments/${attachId}`,
  );
}

/**
 * 更新附件排序
 * PUT /documents/:docId/attachments/:attachId/sort，body：{ sort }
 */
export function updateAttachmentSort(
  docId: string,
  attachId: string,
  sort: number,
): Promise<{ success: boolean }> {
  return client.put<{ success: boolean }, { success: boolean }>(
    `/documents/${docId}/attachments/${attachId}/sort`,
    { sort },
  );
}

/**
 * 获取附件的 kkFileView 预览 URL
 * GET /documents/:docId/attachments/:attachId/kkview
 */
export function getAttachmentKkViewUrl(
  docId: string,
  attachId: string,
): Promise<{ url: string }> {
  return client.get<{ url: string }, { url: string }>(
    `/documents/${docId}/attachments/${attachId}/kkview`,
  );
}

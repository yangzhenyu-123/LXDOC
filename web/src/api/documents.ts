import client from './client';

// 文档格式，与后端 DocumentFormat 枚举对齐
export type DocumentFormat = 'md' | 'txt' | 'docx' | 'odt' | 'pdf';

// 文档实体，与后端 Document 实体对齐
export interface Document {
  id: string;
  categoryId: string;
  title: string;
  content: string | null;
  format: DocumentFormat;
  originalPath: string | null;
  pages: number | null;
  version: number;
  author: string;
  tags: string[];
  // 创建者用户 id，用于前端权限判断（editor 仅可改/删自己创建的）
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// 文档版本列表项（不含 content）
export interface DocumentVersion {
  id: string;
  version: number;
  createdAt: string;
}

// 单个版本内容响应
export interface DocumentVersionContent {
  version: number;
  content: string;
  createdAt: string;
}

// 分类下文档列表项（不含 content）
export interface DocumentListItem {
  id: string;
  title: string;
  format: DocumentFormat;
  version: number;
  tags: string[];
  updatedAt: string;
  // 创建者用户 id，用于前端判断 editor 是否可删
  createdBy: string | null;
}

// 更新文档请求体
export interface UpdateDocumentPayload {
  title?: string;
  content?: string;
  tags?: string[];
}

/**
 * 获取单个文档（含 content）
 * GET /documents/:id
 */
export function getDocument(id: string): Promise<Document> {
  return client.get<Document, Document>(`/documents/${id}`);
}

/**
 * 获取 docx/odt 文档的 HTML 预览片段
 * GET /documents/:id/preview
 * 返回 { html: string }
 */
export async function getPreviewHtml(id: string): Promise<string> {
  const res = await client.get<{ html: string }, { html: string }>(
    `/documents/${id}/preview`,
  );
  return res?.html ?? '';
}

/**
 * 获取 PDF 版式保真 HTML（pdf2htmlEX 生成）
 * GET /documents/:id/pdf-html
 * 返回 { html: string }
 */
export async function getPdfHtml(id: string): Promise<string> {
  const res = await client.get<{ html: string }, { html: string }>(
    `/documents/${id}/pdf-html`,
  );
  return res?.html ?? '';
}

/**
 * 将 PDF 转为可编辑的新 markdown 文档（原 PDF 保留）
 * POST /documents/:id/convert-to-editable
 * 返回新创建的文档
 */
export function convertToEditable(id: string): Promise<Document> {
  return client.post<Document, Document>(
    `/documents/${id}/convert-to-editable`,
  );
}

/**
 * OnlyOffice 前端初始化 config（结构，与后端 OnlyOfficeConfig 对齐）
 */
export interface OnlyOfficeConfig {
  documentType: 'word' | 'cell' | 'slide';
  document: {
    fileType: string;
    key: string;
    title: string;
    url: string;
    permissions: {
      edit: boolean;
      download: boolean;
      print: boolean;
      review: boolean;
    };
  };
  editorConfig: {
    mode: 'edit' | 'view';
    callbackUrl: string;
    lang: string;
    user: { id: string; name: string };
    customization?: {
      forcesave: boolean;
      autosave: boolean;
    };
  };
  token?: string;
}

/**
 * 获取 OnlyOffice 初始化 config
 * GET /documents/:id/onlyoffice/config?mode=edit|view
 * mode 省略时后端按写权限决定
 */
export function getOnlyOfficeConfig(
  id: string,
  mode?: 'edit' | 'view',
): Promise<OnlyOfficeConfig> {
  return client.get<OnlyOfficeConfig, OnlyOfficeConfig>(
    `/documents/${id}/onlyoffice/config`,
    { params: mode ? { mode } : {} },
  );
}

/**
 * 更新文档（创建版本快照 + version + 1）
 * PUT /documents/:id
 */
export function updateDocument(
  id: string,
  payload: UpdateDocumentPayload,
): Promise<Document> {
  return client.put<Document, Document>(`/documents/${id}`, payload);
}

/**
 * 删除文档（editor+，editor 仅可删自己创建的，由后端校验）
 * DELETE /documents/:id
 */
export function deleteDocument(id: string): Promise<void> {
  return client.delete<void, void>(`/documents/${id}`);
}

/**
 * 列出文档所有版本（按 version DESC）
 * GET /documents/:id/versions
 */
export function listVersions(id: string): Promise<DocumentVersion[]> {
  return client.get<DocumentVersion[], DocumentVersion[]>(
    `/documents/${id}/versions`,
  );
}

/**
 * 获取指定版本内容
 * GET /documents/:id/versions/:v
 */
export function getVersion(
  id: string,
  version: number,
): Promise<DocumentVersionContent> {
  return client.get<DocumentVersionContent, DocumentVersionContent>(
    `/documents/${id}/versions/${version}`,
  );
}

/**
 * 回滚到指定版本
 * POST /documents/:id/rollback/:v
 */
export function rollback(id: string, version: number): Promise<Document> {
  return client.post<Document, Document>(
    `/documents/${id}/rollback/${version}`,
  );
}

/**
 * 列出某分类下的所有文档
 * GET /categories/:id/documents?includeChildren=true
 * includeChildren=true 时递归包含子分类
 */
export function listByCategory(
  categoryId: string,
  includeChildren = false,
): Promise<DocumentListItem[]> {
  return client.get<DocumentListItem[], DocumentListItem[]>(
    `/categories/${categoryId}/documents`,
    { params: includeChildren ? { includeChildren: 'true' } : {} },
  );
}

/**
 * 列出最近更新的 N 篇文档
 * GET /documents/recent?limit=
 */
export function getRecentDocuments(
  limit = 10,
): Promise<DocumentListItem[]> {
  return client.get<DocumentListItem[], DocumentListItem[]>(
    '/documents/recent',
    { params: { limit } },
  );
}

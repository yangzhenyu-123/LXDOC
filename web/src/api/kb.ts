import client from './client';

/**
 * RAG 知识库前端 API
 *
 * - KB CRUD / retrieve 走 axios client（自动注入 Bearer token + 401 refresh）
 * - askStream 走 fetch + ReadableStream（axios 不支持流式），手动注入 token
 *
 * 后端端点：
 *   GET    /api/knowledge-bases
 *   GET    /api/knowledge-bases/:id
 *   GET    /api/knowledge-bases/:id/stats
 *   GET    /api/knowledge-bases/:id/documents
 *   GET    /api/knowledge-bases/:id/retrieve?query=...&topK=...
 *   POST   /api/knowledge-bases/:id/ask         (SSE 流式)
 *   POST   /api/knowledge-bases                  (admin)
 *   PUT    /api/knowledge-bases/:id              (admin)
 *   DELETE /api/knowledge-bases/:id              (admin)
 *   POST   /api/knowledge-bases/:id/documents    (admin)
 *   DELETE /api/knowledge-bases/:id/documents/:documentId (admin)
 */

// ============ 类型定义（与后端 entity / dto 对齐） ============

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  chunkStrategy: Record<string, any>;
  retrievalConfig: Record<string, any>;
  documentCount: number;
  chunkCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface KbStats {
  documentCount: number;
  chunkCount: number;
  embeddedCount: number;
}

export interface KbDocument {
  documentId: string;
  title: string;
  format: string;
  chunkCount: number;
}

export interface RetrievalResult {
  chunkId: string;
  content: string;
  documentId: string;
  headingPath: string | null;
  chunkType: string;
  metadata: Record<string, any>;
  rank: number;
  score: number;
  hitBy: 'vector' | 'trgm' | 'both';
}

/** RAG 引用元数据（与后端 RagReference 对齐） */
export interface RagReference {
  refId: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string | null;
  snippet: string;
  score: number;
  hitBy: 'vector' | 'trgm' | 'both';
}

/** RAG SSE 事件（与后端 RagEvent 对齐） */
export type RagEvent =
  | { type: 'references'; refs: RagReference[] }
  | { type: 'reasoning'; content: string }
  | { type: 'delta'; content: string }
  | { type: 'done'; answer: string; isFallback: boolean }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

export interface CreateKbPayload {
  name: string;
  description?: string;
  categoryId?: string;
  chunkStrategy?: Record<string, any>;
}

export interface UpdateKbPayload {
  name?: string;
  description?: string;
  categoryId?: string;
  chunkStrategy?: Record<string, any>;
  retrievalConfig?: Record<string, any>;
}

/** 历史对话消息（多轮对话用，与后端 HistoryMessageDto 对齐） */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ============ KB CRUD ============

export function listKbs(): Promise<KnowledgeBase[]> {
  return client.get<KnowledgeBase[], KnowledgeBase[]>('/knowledge-bases');
}

export function getKb(id: string): Promise<KnowledgeBase> {
  return client.get<KnowledgeBase, KnowledgeBase>(`/knowledge-bases/${id}`);
}

export function getKbStats(id: string): Promise<KbStats> {
  return client.get<KbStats, KbStats>(`/knowledge-bases/${id}/stats`);
}

export function listKbDocuments(id: string): Promise<KbDocument[]> {
  return client.get<KbDocument[], KbDocument[]>(`/knowledge-bases/${id}/documents`);
}

export function createKb(payload: CreateKbPayload): Promise<KnowledgeBase> {
  return client.post<KnowledgeBase, KnowledgeBase>('/knowledge-bases', payload);
}

export function updateKb(id: string, payload: UpdateKbPayload): Promise<KnowledgeBase> {
  return client.put<KnowledgeBase, KnowledgeBase>(`/knowledge-bases/${id}`, payload);
}

export async function deleteKb(id: string): Promise<void> {
  await client.delete(`/knowledge-bases/${id}`);
}

export async function addDocumentToKb(
  kbId: string,
  documentId: string,
): Promise<{ chunkCount: number }> {
  return client.post<{ chunkCount: number }, { chunkCount: number }>(
    `/knowledge-bases/${kbId}/documents`,
    { documentId },
  );
}

export async function removeDocumentFromKb(
  kbId: string,
  documentId: string,
): Promise<void> {
  await client.delete(`/knowledge-bases/${kbId}/documents/${documentId}`);
}

// ============ 检索 ============

export function retrieve(
  kbId: string,
  query: string,
  topK?: number,
  documentIds?: string[],
): Promise<RetrievalResult[]> {
  const params: Record<string, string> = { query };
  if (topK !== undefined) params.topK = String(topK);
  if (documentIds && documentIds.length > 0) params.documentIds = documentIds.join(',');
  return client.get<RetrievalResult[], RetrievalResult[]>(
    `/knowledge-bases/${kbId}/retrieve`,
    { params },
  );
}

/** chunk 完整内容（引用预览弹窗用，与后端 getChunk 返回对齐） */
export interface ChunkDetail {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  headingPath: string | null;
  parentChunkId: string | null;
}

/**
 * 获取 chunk 完整内容（引用预览）。
 * 后端会校验 chunk 归属 kbId，防越权。
 */
export function getChunk(kbId: string, chunkId: string): Promise<ChunkDetail> {
  return client.get<ChunkDetail, ChunkDetail>(
    `/knowledge-bases/${kbId}/chunks/${chunkId}`,
  );
}

// ============ RAG 问答（SSE 流式） ============

/**
 * 发起 RAG 问答，返回 SSE 事件异步生成器。
 *
 * 实现：fetch + ReadableStream + TextDecoder 逐块解析 SSE 行。
 * 不用 EventSource（仅支持 GET，且不支持自定义 header）。
 *
 * @param kbId 知识库 id
 * @param query 用户问题
 * @param signal AbortSignal，调用 abort() 中断生成
 * @param options.history 历史对话（多轮对话用，最近 N 轮由后端截断）
 * @param options.documentIds 限定检索文档范围（文档选择器用，空则全 KB 检索）
 */
export async function* askStream(
  kbId: string,
  query: string,
  signal?: AbortSignal,
  options?: { history?: HistoryMessage[]; documentIds?: string[] },
): AsyncGenerator<RagEvent, void, unknown> {
  const token = localStorage.getItem('lxdoc_access_token');
  // baseURL 同 client.ts：/api 由 vite proxy 转发
  const resp = await fetch(`/api/knowledge-bases/${kbId}/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      query,
      ...(options?.history && options.history.length > 0 ? { history: options.history } : {}),
      ...(options?.documentIds && options.documentIds.length > 0 ? { documentIds: options.documentIds } : {}),
    }),
    signal,
  });

  if (!resp.ok) {
    // 401 在 fetch 不走 axios 拦截器，统一返回错误事件
    if (resp.status === 401) {
      throw new Error('登录已失效，请重新登录');
    }
    const text = await resp.text().catch(() => '');
    throw new Error(`请求失败（${resp.status}）：${text.slice(0, 200)}`);
  }
  if (!resp.body) {
    throw new Error('响应无 body');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 事件以空行（\n\n）分隔；按事件切分，最后可能不完整留在 buffer
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const evt of events) {
        const parsed = parseSseEvent(evt);
        if (parsed) yield parsed;
      }
    }
    // flush 残余 buffer（无尾随 \n\n 的事件）
    if (buffer.trim()) {
      const parsed = parseSseEvent(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    try {
      reader.cancel();
    } catch {
      // ignore
    }
  }
}

/**
 * 解析单个 SSE 事件文本为 RagEvent。
 * 事件格式：
 *   data: {"type":"delta","content":"..."}
 *
 * 多行 data 按 SSE 规范应拼接，但本协议每事件单行 data，简化处理。
 *
 * 导出供前端单元测试覆盖（T9）。
 */
export function parseSseEvent(raw: string): RagEvent | null {
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    try {
      return JSON.parse(data) as RagEvent;
    } catch {
      // 单事件 JSON 解析失败跳过（与后端 glm.provider 行为一致）
      console.warn('[kb] SSE 事件 JSON 解析失败：', data.slice(0, 100));
      return null;
    }
  }
  return null;
}

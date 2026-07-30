import client from './client';
import type { DocumentFormat } from './documents';

// 单条检索结果
export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  format: DocumentFormat | string;
  categoryId: string | null;
  categoryName: string | null;
  updatedAt: string;
  version: number;
}

// 检索响应
export interface SearchResponse {
  items: SearchResult[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 全文检索
 * GET /search?q=...&page=...&pageSize=...
 */
export function search(
  q: string,
  page = 1,
  pageSize = 20,
): Promise<SearchResponse> {
  return client.get<SearchResponse, SearchResponse>('/search', {
    params: { q, page, pageSize },
  });
}

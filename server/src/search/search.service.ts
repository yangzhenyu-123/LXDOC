import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Category } from '../categories/category.entity';

/**
 * 单条检索结果
 */
export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  format: string;
  categoryId: string | null;
  categoryName: string | null;
  updatedAt: Date;
  version: number;
}

/**
 * 检索响应
 */
export interface SearchResponse {
  items: SearchResult[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 数据库返回的原始行结构
 */
interface SearchRow {
  id: string;
  title: string;
  content: string | null;
  format: string;
  category_id: string | null;
  updated_at: Date;
  version: number;
  rank: number;
}

@Injectable()
export class SearchService {
  constructor(private readonly entityManager: EntityManager) {}

  /**
   * 全文检索
   * 1. 用 pg_trgm 的 % 操作符 + ILIKE 组合查询
   * 2. 标题命中加权排前
   * 3. 批量补 categoryName
   * 4. 生成高亮片段
   */
  async search(
    q: string,
    page = 1,
    pageSize = 20,
  ): Promise<SearchResponse> {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.max(1, Math.floor(pageSize));
    const offset = (safePage - 1) * safePageSize;

    // ILIKE 模式：'%q%'
    const likePattern = `%${q}%`;

    // 查询命中行 + rank
    // $1 = likePattern, $2 = q, $3 = pageSize, $4 = offset
    const rows = (await this.entityManager.query(
      `SELECT id, title, content, format, category_id, updated_at, version,
              CASE WHEN title ILIKE $1 THEN 0
                   WHEN title % $2 THEN 1
                   WHEN content ILIKE $1 THEN 2
                   ELSE 3 END AS rank
       FROM documents
       WHERE title ILIKE $1 OR content ILIKE $1 OR title % $2 OR content % $2
       ORDER BY rank ASC, updated_at DESC
       LIMIT $3 OFFSET $4`,
      [likePattern, q, safePageSize, offset],
    )) as SearchRow[];

    // 总命中数
    const countRows = (await this.entityManager.query(
      `SELECT COUNT(*)::int AS cnt
       FROM documents
       WHERE title ILIKE $1 OR content ILIKE $1 OR title % $2 OR content % $2`,
      [likePattern, q],
    )) as { cnt: number }[];
    const total = countRows[0]?.cnt ?? 0;

    // 批量查询 categoryName
    const categoryIds = Array.from(
      new Set(
        rows
          .map((r) => r.category_id)
          .filter((id): id is string => !!id),
      ),
    );

    const categoryNameMap = new Map<string, string>();
    if (categoryIds.length > 0) {
      const categoryRepo = this.entityManager.getRepository(Category);
      const categories = await categoryRepo.find({
        where: categoryIds.map((id) => ({ id })),
        select: ['id', 'name'],
      });
      for (const c of categories) {
        categoryNameMap.set(c.id, c.name);
      }
    }

    // 组装结果 + 生成高亮片段
    const items: SearchResult[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      snippet: makeSnippet(r.content, q),
      format: r.format,
      categoryId: r.category_id,
      categoryName: r.category_id
        ? categoryNameMap.get(r.category_id) ?? null
        : null,
      updatedAt: r.updated_at,
      version: r.version,
    }));

    return {
      items,
      total,
      page: safePage,
      pageSize: safePageSize,
    };
  }
}

/**
 * 转义正则特殊字符，用于把 q 作为字面量拼接 RegExp
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 在 content 中查找 q 出现位置，截取前后 50 字符并加 <mark>
 * - 未命中返回前 100 字符
 */
function makeSnippet(content: string | null, q: string): string {
  if (!content) return '';
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) {
    return content.slice(0, 100);
  }
  const start = Math.max(0, idx - 50);
  const end = Math.min(content.length, idx + q.length + 50);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  const snippet = prefix + content.slice(start, end) + suffix;
  return snippet.replace(
    new RegExp(escapeRegExp(q), 'gi'),
    (m) => `<mark>${m}</mark>`,
  );
}

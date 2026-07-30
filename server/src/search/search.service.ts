import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Category } from '../categories/category.entity';
import { AccessControlService } from '../organizations/access-control.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { DocumentOwnerType } from '../documents/document.entity';

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
  constructor(
    private readonly entityManager: EntityManager,
    private readonly accessControl: AccessControlService,
  ) {}

  /**
   * 全文检索
   * 1. 用 pg_trgm 的 % 操作符 + ILIKE 组合查询
   * 2. 标题命中加权排前
   * 3. 按当前用户读权限过滤可见范围
   * 4. 批量补 categoryName
   * 5. 生成高亮片段
   */
  async search(
    q: string,
    user: AuthUser,
    page = 1,
    pageSize = 20,
  ): Promise<SearchResponse> {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.max(1, Math.floor(pageSize));
    const offset = (safePage - 1) * safePageSize;

    // ILIKE 模式：'%q%'
    const likePattern = `%${q}%`;

    // 构造读权限 SQL 片段与参数（位置参数从 $5 起，前 4 个留给 likePattern/q/pageSize/offset）
    const scope = this.accessControl.getReadScope(user);
    let scopeSql = '';
    const scopeParams: unknown[] = [];
    if (!scope.isFullAccess) {
      // 个人文档 OR 归属祖先 org 的文档
      // 参数：personal、userId、group、department、ancestorIds[]
      const ancestorIds = scope.ancestorOrgIds;
      scopeParams.push(
        DocumentOwnerType.PERSONAL,
        scope.userId,
        DocumentOwnerType.GROUP,
        DocumentOwnerType.DEPARTMENT,
      );
      if (ancestorIds.length > 0) {
        scopeSql =
          `AND ( (owner_type = $5 AND owner_id = $6) OR ` +
          `(owner_type IN ($7,$8) AND owner_id = ANY($9::uuid[])) )`;
        scopeParams.push(ancestorIds);
      } else {
        scopeSql = `AND (owner_type = $5 AND owner_id = $6)`;
      }
    }

    // 查询命中行 + rank
    // $1 = likePattern, $2 = q, $3 = pageSize, $4 = offset, $5+ = scope
    const rows = (await this.entityManager.query(
      `SELECT id, title, content, format, category_id, updated_at, version,
              CASE WHEN title ILIKE $1 THEN 0
                   WHEN title % $2 THEN 1
                   WHEN content ILIKE $1 THEN 2
                   ELSE 3 END AS rank
       FROM documents
       WHERE (title ILIKE $1 OR content ILIKE $1 OR title % $2 OR content % $2)
       ${scopeSql}
       ORDER BY rank ASC, updated_at DESC
       LIMIT $3 OFFSET $4`,
      [likePattern, q, safePageSize, offset, ...scopeParams],
    )) as SearchRow[];

    // 总命中数
    const countRows = (await this.entityManager.query(
      `SELECT COUNT(*)::int AS cnt
       FROM documents
       WHERE (title ILIKE $1 OR content ILIKE $1 OR title % $2 OR content % $2)
       ${scopeSql}`,
      [likePattern, q, ...scopeParams],
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

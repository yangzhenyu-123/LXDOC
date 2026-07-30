import client from './client';

/**
 * 文件 token 响应
 * GET /files/token/:docId，返回绑定 docId 的短期签名 token
 */
export interface FileTokenResponse {
  token: string;
}

/**
 * token 缓存条目
 * 后端默认有效期 10 分钟，前端按 8 分钟刷新，留 2 分钟余量避免临界过期
 */
interface TokenCacheEntry {
  token: string;
  fetchedAt: number;
}

const TOKEN_TTL_MS = 8 * 60 * 1000;
const tokenCache = new Map<string, TokenCacheEntry>();

/**
 * 获取某文档的文件访问 token（带内存缓存）
 * 用于给 <img src>/pdf 加载的文件 URL 拼接 ?token=
 */
export async function getFileToken(docId: string): Promise<string> {
  const cached = tokenCache.get(docId);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) {
    return cached.token;
  }
  const res = await client.get<FileTokenResponse, FileTokenResponse>(
    `/files/token/${docId}`,
  );
  const token = res?.token ?? '';
  tokenCache.set(docId, { token, fetchedAt: Date.now() });
  return token;
}

/**
 * 失效某文档的 token 缓存（文档切换/权限变更时调用）
 */
export function invalidateFileToken(docId: string): void {
  tokenCache.delete(docId);
}

/**
 * 构造原文件签名 URL（pdf/docx 原文件下载）
 */
export function buildOriginalUrl(docId: string, token: string): string {
  return `/api/files/${docId}/original?token=${encodeURIComponent(token)}`;
}

/**
 * 给 markdown / HTML 内容中的 /api/files/:id/image/:name URL 追加 ?token=
 * - 已带 query 的不重复追加
 * - token 为空时原样返回
 */
export function rewriteImageUrls(content: string, token: string): string {
  if (!content || !token) return content;
  return content.replace(
    /((?:\/api\/files\/[^/)]+\/image\/[^/)?]+))/g,
    (url) => {
      if (url.includes('?token=')) return url;
      return `${url}?token=${encodeURIComponent(token)}`;
    },
  );
}

/**
 * 移除 /api/files/... URL 上的 ?token= 参数
 * 用于编辑器回灌前清掉 token，保证存库内容不含短期 token
 */
export function stripFileTokens(content: string): string {
  if (!content) return content;
  return content.replace(
    /(\/api\/files\/[^/)]+\/(?:image|original)\/[^/)?]+)\?token=[^)"\s]*/g,
    '$1',
  );
}

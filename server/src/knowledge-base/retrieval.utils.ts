/**
 * 检索纯函数（无 IO，可独立测试）
 *
 * 从 RetrievalService 提取的纯逻辑：
 * - rrfFuse：RRF 融合算法
 * - 类型定义 VectorHit / TrgmHit / FusedResult
 *
 * 提取目的：让 RRF 融合逻辑可被单元测试直接覆盖，无需 mock EntityManager。
 * 行为与原 RetrievalService.rrfFuse 完全一致。
 */

/** 向量召回项（来自 pgvector cosine 距离排序） */
export interface VectorHit {
  chunkId: string;
  content: string;
  documentId: string;
  headingPath: string | null;
  chunkType: string;
  metadata: Record<string, any>;
  rank: number;
  similarity: number;
}

/** 词法召回项（来自 pg_trgm similarity 排序） */
export interface TrgmHit {
  chunkId: string;
  content: string;
  documentId: string;
  headingPath: string | null;
  chunkType: string;
  metadata: Record<string, any>;
  rank: number;
  similarity: number;
}

/** 融合后结果 */
export interface FusedResult {
  chunkId: string;
  content: string;
  documentId: string;
  headingPath: string | null;
  chunkType: string;
  metadata: Record<string, any>;
  /** RRF 融合分数（越高越相关） */
  score: number;
  /** 命中的检索路：vector / trgm / both */
  hitBy: 'vector' | 'trgm' | 'both';
}

/**
 * RRF（Reciprocal Rank Fusion）融合
 *
 * score = 1/(k+rank_vector) + 1/(k+rank_trgm)
 * - 两路都命中：score 为两路贡献之和，hitBy='both'
 * - 仅一路命中：score 为该路贡献，hitBy 对应 'vector' 或 'trgm'
 * - 结果按 score 降序排列
 *
 * @param vectorHits 向量召回结果（按 similarity 降序，rank 从 1 开始）
 * @param trgmHits 词法召回结果（按 similarity 降序，rank 从 1 开始）
 * @param k RRF 常量（标准 60，越大越平滑排名差异）
 * @returns 融合后按 score 降序的结果数组
 */
export function rrfFuse(
  vectorHits: VectorHit[],
  trgmHits: TrgmHit[],
  k: number,
): FusedResult[] {
  const map = new Map<string, FusedResult>();

  for (const h of vectorHits) {
    map.set(h.chunkId, {
      chunkId: h.chunkId,
      content: h.content,
      documentId: h.documentId,
      headingPath: h.headingPath,
      chunkType: h.chunkType,
      metadata: h.metadata,
      score: 1 / (k + h.rank),
      hitBy: 'vector',
    });
  }

  for (const h of trgmHits) {
    const existing = map.get(h.chunkId);
    if (existing) {
      existing.score += 1 / (k + h.rank);
      existing.hitBy = 'both';
    } else {
      map.set(h.chunkId, {
        chunkId: h.chunkId,
        content: h.content,
        documentId: h.documentId,
        headingPath: h.headingPath,
        chunkType: h.chunkType,
        metadata: h.metadata,
        score: 1 / (k + h.rank),
        hitBy: 'trgm',
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.score - a.score);
}

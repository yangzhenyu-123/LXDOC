import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { EmbeddingService } from './embedding.service';

/**
 * 检索结果项
 */
export interface RetrievalResult {
  /** chunk id */
  chunkId: string;
  /** chunk 文本 */
  content: string;
  /** 关联文档 id */
  documentId: string;
  /** 标题路径 */
  headingPath: string | null;
  /** chunk 类型 */
  chunkType: string;
  /** 元数据 */
  metadata: Record<string, any>;
  /** 融合后排名（1 = 最佳） */
  rank: number;
  /** RRF 融合分数（越高越相关） */
  score: number;
  /** 命中的检索路：vector / trgm / both */
  hitBy: 'vector' | 'trgm' | 'both';
}

/**
 * 检索配置
 */
export interface RetrievalConfig {
  /** 向量召回数 */
  vectorTopK: number;
  /** 词法召回数 */
  trgmTopK: number;
  /** RRF 融合参数（常量 60，标准 RRF） */
  rrfK: number;
  /** 最终返回数 */
  finalTopK: number;
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  vectorTopK: 20,
  trgmTopK: 20,
  rrfK: 60,
  finalTopK: 10,
};

/**
 * 混合检索服务
 *
 * 策略：
 * 1. 向量召回：query embedding → pgvector cosine 距离 top-K
 * 2. 词法召回：pg_trgm similarity top-K
 * 3. RRF 融合两路排名：score = 1/(rrfK + rank_vector) + 1/(rrfK + rank_trgm)
 * 4. 按 RRF 分数降序，取 finalTopK
 *
 * 若 embedding 不可用（TEI 未就绪），仅走词法召回降级。
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly entityManager: EntityManager,
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * 混合检索
   * @param kbId 知识库 id
   * @param query 用户查询文本
   * @param config 检索配置，省略用默认
   */
  async retrieve(
    kbId: string,
    query: string,
    config?: Partial<RetrievalConfig>,
  ): Promise<RetrievalResult[]> {
    const cfg: RetrievalConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
    if (!query.trim()) return [];

    // 1. 向量召回（若 TEI 可用）
    let vectorHits: VectorHit[] = [];
    if (this.embeddingService.isReady()) {
      try {
        const queryVec = await this.embeddingService.embed(query);
        if (queryVec && queryVec.length > 0) {
          vectorHits = await this.vectorSearch(kbId, queryVec, cfg.vectorTopK);
        } else {
          this.logger.warn(`query embedding 返回空，跳过向量召回`);
        }
      } catch (err) {
        this.logger.warn(`向量召回失败，降级仅词法：${(err as Error).message}`);
      }
    } else {
      this.logger.warn(`embedding 服务未就绪，仅走词法召回`);
    }

    // 2. 词法召回
    const trgmHits = await this.trgmSearch(kbId, query, cfg.trgmTopK);

    // 3. RRF 融合
    const fused = this.rrfFuse(vectorHits, trgmHits, cfg.rrfK);

    // 4. 取 finalTopK
    const results = fused.slice(0, cfg.finalTopK).map((f, i) => ({
      chunkId: f.chunkId,
      content: f.content,
      documentId: f.documentId,
      headingPath: f.headingPath,
      chunkType: f.chunkType,
      metadata: f.metadata,
      rank: i + 1,
      score: f.score,
      hitBy: f.hitBy,
    }));

    this.logger.log(
      `检索 kb=${kbId.slice(0, 8)} query="${query.slice(0, 30)}" ` +
      `向量=${vectorHits.length} 词法=${trgmHits.length} 融合=${results.length}`,
    );
    return results;
  }

  /**
   * 向量召回：pgvector cosine 距离排序
   */
  private async vectorSearch(
    kbId: string,
    queryVec: number[],
    topK: number,
  ): Promise<VectorHit[]> {
    const vecLiteral = `[${queryVec.join(',')}]`;
    const rows = await this.entityManager.query(
      `SELECT id, content, document_id, heading_path, chunk_type, metadata,
              1 - (embedding <=> $1::vector) AS similarity
       FROM kb_chunks
       WHERE kb_id = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [vecLiteral, kbId, topK],
    );
    return (rows ?? []).map((r: any, i: number) => ({
      chunkId: r.id,
      content: r.content,
      documentId: r.document_id,
      headingPath: r.heading_path,
      chunkType: r.chunk_type,
      metadata: r.metadata ?? {},
      rank: i + 1,
      similarity: r.similarity,
    }));
  }

  /**
   * 词法召回：pg_trgm similarity 排序
   * 不用 % 操作符（受 similarity_threshold 阈值限制），改用 similarity() 函数 + 硬编码阈值过滤，
   * 避免修改 session 级参数。
   */
  private async trgmSearch(
    kbId: string,
    query: string,
    topK: number,
  ): Promise<TrgmHit[]> {
    // 转义 ILIKE 通配符
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const rows = await this.entityManager.query(
      `SELECT id, content, document_id, heading_path, chunk_type, metadata,
              similarity(content, $1) AS sim
       FROM kb_chunks
       WHERE kb_id = $2
         AND similarity(content, $1) > 0.05
       ORDER BY sim DESC
       LIMIT $3`,
      [escaped, kbId, topK],
    );
    return (rows ?? []).map((r: any, i: number) => ({
      chunkId: r.id,
      content: r.content,
      documentId: r.document_id,
      headingPath: r.heading_path,
      chunkType: r.chunk_type,
      metadata: r.metadata ?? {},
      rank: i + 1,
      similarity: r.similarity,
    }));
  }

  /**
   * RRF 融合
   * score = 1/(k+rank_v) + 1/(k+rank_t)
   * 仅一路命中时，该路贡献 1/(k+rank)
   */
  private rrfFuse(
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
}

interface VectorHit {
  chunkId: string;
  content: string;
  documentId: string;
  headingPath: string | null;
  chunkType: string;
  metadata: Record<string, any>;
  rank: number;
  similarity: number;
}

interface TrgmHit {
  chunkId: string;
  content: string;
  documentId: string;
  headingPath: string | null;
  chunkType: string;
  metadata: Record<string, any>;
  rank: number;
  similarity: number;
}

interface FusedResult {
  chunkId: string;
  content: string;
  documentId: string;
  headingPath: string | null;
  chunkType: string;
  metadata: Record<string, any>;
  score: number;
  hitBy: 'vector' | 'trgm' | 'both';
}

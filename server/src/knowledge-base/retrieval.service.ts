import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { EmbeddingService } from './embedding.service';
import { rrfFuse, VectorHit, TrgmHit, FusedResult } from './retrieval.utils';

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
  /** 限定检索文档范围（空则全 KB 检索，文档选择器用） */
  documentIds?: string[];
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
   * @param config 检索配置，省略用默认。documentIds 限定检索文档范围
   */
  async retrieve(
    kbId: string,
    query: string,
    config?: Partial<RetrievalConfig>,
  ): Promise<RetrievalResult[]> {
    const cfg: RetrievalConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
    if (!query.trim()) return [];

    // documentIds 过滤条件（空则不过滤，全 KB 检索）
    const docFilter = cfg.documentIds && cfg.documentIds.length > 0 ? cfg.documentIds : null;

    // 1. 向量召回（若 TEI 可用）
    let vectorHits: VectorHit[] = [];
    if (this.embeddingService.isReady()) {
      try {
        const queryVec = await this.embeddingService.embed(query);
        if (queryVec && queryVec.length > 0) {
          vectorHits = await this.vectorSearch(kbId, queryVec, cfg.vectorTopK, docFilter);
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
    const trgmHits = await this.trgmSearch(kbId, query, cfg.trgmTopK, docFilter);

    // 3. RRF 融合（纯函数，从 retrieval.utils 导入）
    const fused = rrfFuse(vectorHits, trgmHits, cfg.rrfK);

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
      `向量=${vectorHits.length} 词法=${trgmHits.length} 融合=${results.length}` +
      (docFilter ? ` docs=${docFilter.length}` : ''),
    );
    return results;
  }

  /**
   * 向量召回：pgvector cosine 距离排序
   * @param docFilter 限定文档范围（null 则不过滤）
   */
  private async vectorSearch(
    kbId: string,
    queryVec: number[],
    topK: number,
    docFilter: string[] | null = null,
  ): Promise<VectorHit[]> {
    const vecLiteral = `[${queryVec.join(',')}]`;
    // 动态拼接 SQL：docFilter 非空时加 document_id 过滤
    const docClause = docFilter ? `AND document_id = ANY($4::uuid[])` : '';
    const params: unknown[] = [vecLiteral, kbId, topK];
    if (docFilter) params.push(docFilter);
    const rows = await this.entityManager.query(
      `SELECT id, content, document_id, heading_path, chunk_type, metadata,
              1 - (embedding <=> $1::vector) AS similarity
       FROM kb_chunks
       WHERE kb_id = $2 AND embedding IS NOT NULL ${docClause}
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      params,
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
   * @param docFilter 限定文档范围（null 则不过滤）
   */
  private async trgmSearch(
    kbId: string,
    query: string,
    topK: number,
    docFilter: string[] | null = null,
  ): Promise<TrgmHit[]> {
    // 转义 ILIKE 通配符
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    // 动态拼接 SQL：docFilter 非空时加 document_id 过滤
    const docClause = docFilter ? `AND document_id = ANY($4::uuid[])` : '';
    const params: unknown[] = [escaped, kbId, topK];
    if (docFilter) params.push(docFilter);
    const rows = await this.entityManager.query(
      `SELECT id, content, document_id, heading_path, chunk_type, metadata,
              similarity(content, $1) AS sim
       FROM kb_chunks
       WHERE kb_id = $2
         AND similarity(content, $1) > 0.05
         ${docClause}
       ORDER BY sim DESC
       LIMIT $3`,
      params,
    );
    return (rows ?? []).map((r: any, i: number) => ({
      chunkId: r.id,
      content: r.content,
      documentId: r.document_id,
      headingPath: r.heading_path,
      chunkType: r.chunk_type,
      metadata: r.metadata ?? {},
      rank: i + 1,
      similarity: r.sim,
    }));
  }
}

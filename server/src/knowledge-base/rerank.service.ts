import { Injectable, Logger } from '@nestjs/common';
import { llmConfig } from '../config/llm.config';

/**
 * Rerank 服务
 *
 * 调用 TEI /rerank 端点对检索结果二次排序。Rerank 模型（cross-encoder）比
 * 向量召回的 bi-encoder 更精准，能显著提升 top-K 的相关性。
 *
 * 设计：与 EmbeddingService 对称——直连 TEI，绕过 LlmService，批量调用。
 * 配置：从 llmConfig.rerankBaseUrl / rerankModel 读取（admin 可在线改）。
 *
 * 参考实现：
 * - MimirQ `app/rag/reranker/factory.py` cross_encoder 类
 * - Yuxi `backend/package/yuxi/models/rerank.py` OpenAIReranker.acompute_score
 * - TEI /rerank 协议：{ query, texts: string[] } → { scores: number[] }
 */
@Injectable()
export class RerankService {
  private readonly logger = new Logger(RerankService.name);

  /** 是否就绪（配置了 rerankBaseUrl） */
  isReady(): boolean {
    return !!llmConfig.rerankBaseUrl;
  }

  /**
   * 对文本列表按 query 相关性重新排序
   *
   * @param query 用户查询
   * @param texts 候选文本数组（建议 <= 32 条，TEI 单批限制）
   * @returns 按相关性降序的 [{ index, score }]（index 指向原 texts 数组）
   */
  async rerank(
    query: string,
    texts: string[],
  ): Promise<Array<{ index: number; score: number }>> {
    if (!this.isReady()) {
      this.logger.debug('Rerank 未就绪，跳过');
      return texts.map((_, i) => ({ index: i, score: 0 }));
    }
    if (texts.length === 0) return [];

    const baseUrl = llmConfig.rerankBaseUrl.replace(/\/$/, '');
    const url = `${baseUrl}/rerank`;
    const model = llmConfig.rerankModel;

    const controller = new AbortController();
    // rerank 模型冷启动较慢，给 60s 超时
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, query, texts }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`TEI rerank HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data: any = await resp.json();
      // TEI rerank 返回 { results: [{ index, score }] }，已按 score 降序
      const results: Array<{ index: number; score: number }> = (data?.results ?? []).map(
        (r: any) => ({
          index: typeof r.index === 'number' ? r.index : 0,
          score: typeof r.relevance_score === 'number' ? r.relevance_score : Number(r.score ?? 0),
        }),
      );
      // 防御：TEI 未排序时按 score 降序
      results.sort((a, b) => b.score - a.score);
      return results;
    } finally {
      clearTimeout(timer);
    }
  }
}

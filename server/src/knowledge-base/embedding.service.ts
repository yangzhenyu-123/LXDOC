import { Injectable, Logger } from '@nestjs/common';
import { llmConfig } from '../config/llm.config';

/**
 * Embedding 服务
 *
 * 直接调用 TEI /embeddings 端点（批量），绕过 LlmService.embed 的单条限制。
 * TEI 支持一次请求传多个 input，性能优于逐条调用。
 *
 * 配置：从 llmConfig.embedBaseUrl / embedModel 读取（由 system_settings 可在线修改）
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  /** 是否就绪（配置了 embedBaseUrl + embedModel） */
  isReady(): boolean {
    return !!llmConfig.embedBaseUrl && !!llmConfig.embedModel;
  }

  /**
   * 批量生成 embedding
   * @param texts 文本数组（建议单批 <= 32 条，TEI 默认 max_client_batch_size=32）
   * @returns 向量数组（顺序与输入一致），失败的位置为 null
   */
  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (!this.isReady()) {
      this.logger.warn('Embedding 服务未就绪（缺 embedBaseUrl 或 embedModel）');
      return texts.map(() => null);
    }
    if (texts.length === 0) return [];

    const baseUrl = llmConfig.embedBaseUrl.replace(/\/$/, '');
    const url = `${baseUrl}/embeddings`;
    const model = llmConfig.embedModel;

    // TEI 单批限制 32 条，超过则分批
    const BATCH_SIZE = 32;
    const results: (number[] | null)[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      try {
        const vectors = await this.requestEmbed(url, model, batch);
        results.push(...vectors);
      } catch (err) {
        this.logger.error(
          `Embedding 批次 ${i / BATCH_SIZE} 失败：${(err as Error).message}`,
        );
        // 失败的批次全部置 null，不阻塞整体
        results.push(...batch.map(() => null));
      }
    }
    return results;
  }

  /** 单条 embedding（便捷方法，内部走 batch） */
  async embed(text: string): Promise<number[] | null> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  /**
   * 调 TEI /embeddings 接口
   * TEI 兼容 OpenAI 格式：{ model, input: string[] } → { data: [{ embedding: number[] }] }
   */
  private async requestEmbed(
    url: string,
    model: string,
    inputs: string[],
  ): Promise<(number[] | null)[]> {
    const controller = new AbortController();
    // TEI 首次冷启动可能较慢，给 60s 超时
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: inputs }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`TEI HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data: any = await resp.json();
      // TEI 返回 { data: [{ index, embedding: [...] }], ... }
      // index 字段对应输入顺序
      const embeddings: (number[] | null)[] = inputs.map(() => null);
      for (const item of data?.data ?? []) {
        const idx = typeof item.index === 'number' ? item.index : 0;
        if (idx < embeddings.length && Array.isArray(item.embedding)) {
          embeddings[idx] = item.embedding;
        }
      }
      return embeddings;
    } finally {
      clearTimeout(timer);
    }
  }
}

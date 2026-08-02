/**
 * Mock RerankService（集成测试用）
 *
 * 提供：
 * - isReady() 受控
 * - rerank() 返回可控 score 数组（默认按输入顺序递减）
 *
 * 用结构类型兼容 RetrievalService 的 RerankService 依赖。
 */
import { RerankService } from '../src/knowledge-base/rerank.service';

export interface MockRerankOptions {
  isReady?: boolean;
  /** 自定义 score 数组（按输入顺序，未排序） */
  scores?: number[];
}

/**
 * 构造 mock RerankService（结构类型兼容）
 */
export function createMockRerankService(opts: MockRerankOptions = {}): RerankService {
  const isReady = opts.isReady ?? true;
  const scores = opts.scores ?? [];

  return {
    isReady: () => isReady,
    rerank: async (query: string, texts: string[]) => {
      // 默认 score 按输入顺序递减（index 0 最高），保证第 0 个排第一
      const s = scores.length > 0
        ? scores
        : texts.map((_, i) => 1 - i * 0.1);
      return texts
        .map((_, i) => ({ index: i, score: s[i] ?? 0 }))
        .sort((a, b) => b.score - a.score);
    },
  } as unknown as RerankService;
}

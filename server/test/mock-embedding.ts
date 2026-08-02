/**
 * Mock EmbeddingService（集成测试用）
 *
 * 提供：
 * - isReady() 受控
 * - embedBatch/embed 返回确定性向量（按文本 hash，相似文本向量相近）
 * - 可注入自定义向量映射（测试 retrieve 时精确控制相似度）
 *
 * 用结构类型兼容 KnowledgeBaseService/RetrievalService 的 EmbeddingService 依赖。
 */
import { EmbeddingService } from '../src/knowledge-base/embedding.service';

export interface MockEmbeddingOptions {
  isReady?: boolean;
  /** 自定义文本→向量映射，优先于确定性向量 */
  vectorMap?: Map<string, number[]>;
  /** 默认向量维度 */
  dimensions?: number;
}

/**
 * 确定性向量：基于文本内容生成，相似文本向量相近（cosine 相似度较高）
 * 用于 addDocument 测试（验证入库即可，不要求精确相似度）
 */
export function deterministicVector(text: string, dims = 1024): number[] {
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dims] += text.charCodeAt(i) / 1000;
  }
  // L2 归一化（pgvector cosine 距离要求）
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

/**
 * 构造 mock EmbeddingService（结构类型兼容）
 */
export function createMockEmbeddingService(opts: MockEmbeddingOptions = {}): EmbeddingService {
  const dims = opts.dimensions ?? 1024;
  const isReady = opts.isReady ?? true;
  const vectorMap = opts.vectorMap ?? new Map();

  const resolve = (text: string): number[] | null => {
    if (vectorMap.has(text)) return vectorMap.get(text)!;
    return deterministicVector(text, dims);
  };

  // 结构类型兼容 EmbeddingService（只需 public 方法签名匹配）
  return {
    isReady: () => isReady,
    embedBatch: async (texts: string[]): Promise<(number[] | null)[]> =>
      texts.map((t) => resolve(t)),
    embed: async (text: string): Promise<number[] | null> => resolve(text),
  } as unknown as EmbeddingService;
}

/**
 * 构造正交向量（cosine 相似度 = 0，互不相关）
 * 用于 retrieve 测试：chunk A 向量 e1，chunk B 向量 e2，query 向量 e1 → A 命中
 */
export function unitVector(dim: number, dims = 1024): number[] {
  const vec = new Array(dims).fill(0);
  if (dim < dims) vec[dim] = 1;
  return vec;
}

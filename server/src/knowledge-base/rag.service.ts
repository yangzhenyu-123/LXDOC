import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Document } from '../documents/document.entity';
import { RetrievalService, RetrievalResult } from './retrieval.service';
import { LlmService } from '../llm/llm.service';
import { LlmMessage } from '../llm/llm-provider.interface';
import { OptionalLlm } from '../llm/optional-llm.decorator';
import { buildKnowledge, buildPrompt, classifyScore, truncateHistory, HistoryMessage } from './rag.utils';

/**
 * RAG 引用元数据（回传给前端）
 * 对应 prompt 中 [资料 N] 的编号
 */
export interface RagReference {
  /** 引用编号（1-based，对应 prompt 中 [资料 1] [资料 2]） */
  refId: number;
  /** chunk id */
  chunkId: string;
  /** 关联文档 id */
  documentId: string;
  /** 文档标题（来自 documents 表） */
  documentTitle: string;
  /** 标题路径（chunk 所在章节） */
  headingPath: string | null;
  /** 内容片段（前 200 字符，前端展示用） */
  snippet: string;
  /** RRF 融合分数 */
  score: number;
  /** 命中的检索路 */
  hitBy: 'vector' | 'trgm' | 'both';
}

/**
 * RAG 事件（SSE 流式）
 * - references：引用元数据（生成前下发，保底）
 * - reasoning：GLM 思考链增量
 * - delta：正文增量
 * - done：完成
 * - error：错误
 * - cancelled：用户中断
 */
export type RagEvent =
  | { type: 'references'; refs: RagReference[] }
  | { type: 'reasoning'; content: string }
  | { type: 'delta'; content: string }
  | { type: 'done'; answer: string; isFallback: boolean }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

/**
 * RAG 配置
 */
export interface RagConfig {
  /** 检索 finalTopK（传给 RetrievalService） */
  retrievalTopK: number;
  /** 拒答阈值：top1 score < abstainThreshold 直接拒答 */
  abstainThreshold: number;
  /** 降级阈值：top1 score < degradeThreshold 时标注 isFallback */
  degradeThreshold: number;
  /** 单 chunk 内容最大字符数（拼 prompt 时截断） */
  maxChunkChars: number;
  /** 上下文总最大字符数（拼 prompt 时截断） */
  maxContextChars: number;
  /** LLM 温度 */
  temperature: number;
  /** LLM 最大输出 token */
  maxTokens: number;
  /** LLM 超时（毫秒） */
  llmTimeout: number;
}

export const DEFAULT_RAG_CONFIG: RagConfig = {
  retrievalTopK: 8,
  // RRF score 阈值（基于 bge-m3 + RRF k=60 的 score 分布校准）：
  //   both 命中两路 rank 1/1：1/61 + 1/61 ≈ 0.0328（最高分，强相关）
  //   单路命中 rank 1：1/61 ≈ 0.0164（弱相关，bge-m3 中文基础相似度）
  //   单路命中 rank N：1/(60+N)
  // 实测：bge-m3 对任意中文 query 都有 0.015-0.017 的基础向量相似度，
  //       单路 rank 1（0.0164）不构成真正相关，需 both 命中才算相关。
  // 阈值含义：
  //   abstainThreshold=0.020：低于单路 rank 1 的最高分 → 拒答（bge-m3 基础相似度）
  //   degradeThreshold=0.030：低于 both rank 1 的分数 → 降级标注（仅单路命中）
  abstainThreshold: 0.020,
  degradeThreshold: 0.030,
  maxChunkChars: 2000,
  maxContextChars: 8000,
  temperature: 0.3,
  maxTokens: 2048,
  llmTimeout: 120_000, // RAG 生成耗时较长，给 2 分钟
};

/**
 * RAG 问答服务
 *
 * 链路：检索 → 拒答判断 → 引用元数据下发 → 组装 prompt → GLM 流式生成 → SSE 事件
 *
 * 设计参考（8 项目调研结论）：
 * - SSE + type 字段事件协议（全员共识）
 * - 引用双轨制：后端结构化保底（references 事件）+ LLM 内联增强（[1][2] prompt 约定）
 * - 拒答三档阈值（WeKnora）
 * - 上下文双维度截断（MimirQ）
 * - prompt 模板：{knowledge} 占位符 + 独立引用规则（ragflow）
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private readonly retrievalService: RetrievalService,
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    @OptionalLlm() private readonly llmService?: LlmService,
  ) {}

  /**
   * RAG 问答（流式）
   * @param kbId 知识库 id
   * @param query 用户问题
   * @param signal 中断信号（用户停止生成时 abort）
   * @param options 可选：history（多轮对话历史）+ documentIds（限定检索文档范围）+ config（RAG 配置覆盖）
   * @returns 异步生成器，逐个产出 RagEvent
   */
  async *ask(
    kbId: string,
    query: string,
    signal?: AbortSignal,
    options?: {
      history?: HistoryMessage[];
      documentIds?: string[];
      config?: Partial<RagConfig>;
    },
  ): AsyncGenerator<RagEvent, void, unknown> {
    const cfg: RagConfig = { ...DEFAULT_RAG_CONFIG, ...options?.config };
    if (!query.trim()) {
      yield { type: 'error', message: '问题不能为空' };
      return;
    }

    // 1. 检索（documentIds 限定范围，多轮对话时仍按当前 query 检索）
    let chunks: RetrievalResult[];
    try {
      chunks = await this.retrievalService.retrieve(kbId, query, {
        finalTopK: cfg.retrievalTopK,
        ...(options?.documentIds && options.documentIds.length > 0
          ? { documentIds: options.documentIds }
          : {}),
      });
    } catch (err) {
      this.logger.warn(`检索失败：${(err as Error).message}`);
      yield { type: 'error', message: '检索失败，请稍后重试' };
      return;
    }

    // 2. 拒答判断（top1 score < abstainThreshold 直接拒答）
    const topScore = chunks[0]?.score ?? 0;
    const scoreClass = classifyScore(topScore, cfg);
    if (chunks.length === 0 || scoreClass === 'abstain') {
      this.logger.log(
        `拒答 kb=${kbId.slice(0, 8)} query="${query.slice(0, 30)}" topScore=${topScore.toFixed(4)} < ${cfg.abstainThreshold}`,
      );
      yield {
        type: 'done',
        answer: '未在知识库中找到相关资料，请尝试换个问法或补充更多上下文。',
        isFallback: true,
      };
      return;
    }
    const isFallback = scoreClass === 'degrade';

    // 3. 查文档标题（用于引用元数据展示）
    const docIds = [...new Set(chunks.map((c) => c.documentId))];
    let titleMap = new Map<string, string>();
    try {
      const docs = await this.docRepo.find({
        where: { id: In(docIds) },
        select: ['id', 'title'],
      });
      titleMap = new Map(docs.map((d) => [d.id, d.title]));
    } catch (err) {
      this.logger.warn(`加载文档标题失败：${(err as Error).message}`);
      yield { type: 'error', message: '加载文档信息失败，请稍后重试' };
      return;
    }

    // 4. 引用元数据下发（生成前，保底）
    const refs: RagReference[] = chunks.map((c, i) => ({
      refId: i + 1,
      chunkId: c.chunkId,
      documentId: c.documentId,
      documentTitle: titleMap.get(c.documentId) ?? '(未知文档)',
      headingPath: c.headingPath,
      snippet: c.content.slice(0, 200),
      score: c.score,
      hitBy: c.hitBy,
    }));
    yield { type: 'references', refs };

    // 5. 组装 prompt（含历史对话拼接，纯函数从 rag.utils 导入）
    const knowledge = buildKnowledge(chunks, titleMap, cfg);
    const truncatedHistory = truncateHistory(options?.history ?? []);
    const messages = buildPrompt(query, knowledge, truncatedHistory);
    this.logger.log(
      `RAG 问答 kb=${kbId.slice(0, 8)} query="${query.slice(0, 30)}" ` +
      `chunks=${chunks.length} topScore=${topScore.toFixed(4)} fallback=${isFallback}` +
      (truncatedHistory.length > 0 ? ` history=${truncatedHistory.length}` : ''),
    );

    // 6. LLM 就绪检查（未启用时显式 error，避免空答案让用户困惑）
    if (!this.llmService?.isReady()) {
      this.logger.warn('LLM 未就绪，RAG 问答不可用');
      yield { type: 'error', message: 'AI 服务未启用，请联系管理员' };
      return;
    }

    // 7. GLM 流式生成
    // 降级场景前置提示：作为 delta 在流首下发，前端按 delta 拼接即可保持流式与非流式一致
    let fullAnswer = '';
    if (isFallback) {
      const prefix = '⚠️ 以下信息相关度较低，仅供参考：\n\n';
      fullAnswer += prefix;
      yield { type: 'delta', content: prefix };
    }
    try {
      for await (const chunk of this.llmService.streamChat(messages, {
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        timeout: cfg.llmTimeout,
        signal,
      })) {
        // 用户中断
        if (signal?.aborted) {
          yield { type: 'cancelled' };
          return;
        }
        if (chunk.type === 'reasoning') {
          yield { type: 'reasoning', content: chunk.content };
        } else if (chunk.type === 'delta') {
          fullAnswer += chunk.content;
          yield { type: 'delta', content: chunk.content };
        } else if (chunk.type === 'error') {
          // LLM 失败（含降级也失败）→ error 事件，前端明确感知
          yield { type: 'error', message: chunk.message };
          return;
        } else if (chunk.type === 'done') {
          break;
        }
      }
    } catch (err) {
      // AbortError 已在 signal?.aborted 处理，这里处理其他错误
      if ((err as Error).name === 'AbortError') {
        yield { type: 'cancelled' };
        return;
      }
      this.logger.warn(`GLM 流式生成失败：${(err as Error).message}`);
      yield { type: 'error', message: '生成失败，请稍后重试' };
      return;
    }

    // Provider 静默结束（如 GlmProvider 捕获 AbortError 后 return，不 yield 任何 chunk）
    // 此时 for await 正常退出但 signal 已 aborted，需补检查避免错误 yield done
    if (signal?.aborted) {
      yield { type: 'cancelled' };
      return;
    }

    // 8. 完成
    yield { type: 'done', answer: fullAnswer, isFallback };
  }
}

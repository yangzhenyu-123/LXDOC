import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import {
  LLM_PROVIDERS,
  LlmChatOptions,
  LlmChatResult,
  LlmEmbedResult,
  LlmMessage,
  LlmNotSupportedException,
  LlmProvider,
  LlmStreamChunk,
  LlmStreamProvider,
} from './llm-provider.interface';

/**
 * LLM 编排服务
 *
 * 职责：
 * 1. 聚合所有 Provider，选择首个 isReady() 的作为活跃 Provider
 * 2. 暴露统一入口 chat/embed/streamChat/health，业务模块只依赖 LlmService（不直接依赖 Provider）
 * 3. 失败/未启用时降级：chat 返回 null，embed 返回 null，不抛错（除非显式要求）
 *
 * 业务接入示例（后续迭代）：
 *   constructor(@OptionalLlm() private llm?: LlmService) {}
 *   async summarize(text) { return (await this.llm?.chat(...))?.content ?? null; }
 *
 * 流式接入：
 *   for await (const chunk of this.llm.streamChat(messages)) { ... }
 *   不支持流式时回退到 chat（同步返回一个完整 chunk）
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    @Inject(LLM_PROVIDERS) private readonly providers: LlmProvider[],
  ) {}

  /**
   * 当前活跃 Provider（首个 isReady 的）
   * 没有就绪 Provider 时返回 null
   */
  getActiveProvider(): LlmProvider | null {
    return this.providers.find((p) => p.isReady()) ?? null;
  }

  /**
   * 是否就绪（至少一个 Provider 可用）
   */
  isReady(): boolean {
    return this.getActiveProvider() !== null;
  }

  /**
   * 健康检查：列出每个 Provider 的就绪状态
   * 供 GET /api/llm/health 接口返回
   */
  health(): {
    ready: boolean;
    activeProvider: string | null;
    providers: { name: string; ready: boolean }[];
  } {
    const list = this.providers.map((p) => ({
      name: p.name,
      ready: p.isReady(),
    }));
    const active = this.getActiveProvider();
    return {
      ready: !!active,
      activeProvider: active?.name ?? null,
      providers: list,
    };
  }

  /**
   * 同步对话（降级返回 null）
   * 业务层据返回值决定是否启用 AI 功能
   */
  async chat(
    messages: LlmMessage[],
    opts?: LlmChatOptions,
  ): Promise<LlmChatResult | null> {
    const provider = this.getActiveProvider();
    if (!provider) {
      this.logger.debug('LLM 未就绪，chat 降级返回 null');
      return null;
    }
    try {
      return await provider.chat(messages, opts);
    } catch (err) {
      this.logger.warn(
        `LLM chat 失败（provider=${provider.name}）：${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * 向量嵌入（降级返回 null）
   * Provider 不支持 embedding 时返回 null（业务层据此禁用 RAG）
   */
  async embed(text: string, model?: string): Promise<LlmEmbedResult | null> {
    const provider = this.getActiveProvider();
    if (!provider) {
      return null;
    }
    try {
      return await provider.embed(text, model);
    } catch (err) {
      if (err instanceof LlmNotSupportedException) {
        this.logger.debug(
          `Provider ${provider.name} 不支持 embedding：${err.message}`,
        );
      } else {
        this.logger.warn(
          `LLM embed 失败（provider=${provider.name}）：${(err as Error).message}`,
        );
      }
      return null;
    }
  }

  /**
   * 流式对话（降级：Provider 不支持流式时回退到同步 chat，一次性产出完整内容）
   *
   * 用法：
   *   for await (const chunk of this.llm.streamChat(messages, { signal })) {
   *     if (chunk.type === 'reasoning') { ... }
   *     if (chunk.type === 'delta') { ... }
   *     if (chunk.type === 'done') { ... }
   *   }
   *
   * 传 signal 可中断流式：signal.abort() → fetch AbortError → 生成器终止。
   */
  async *streamChat(
    messages: LlmMessage[],
    opts?: LlmChatOptions & { signal?: AbortSignal },
  ): AsyncGenerator<LlmStreamChunk, void, unknown> {
    const provider = this.getActiveProvider();
    if (!provider) {
      this.logger.debug('LLM 未就绪，streamChat 降级返回空');
      yield { type: 'error', message: 'AI 服务未启用' };
      return;
    }
    // 支持 LlmStreamProvider 接口时走原生流式
    if (this.isStreamProvider(provider)) {
      try {
        yield* provider.streamChat(messages, opts);
        return;
      } catch (err) {
        // 用户中断（AbortError）不算错误，静默结束
        if ((err as Error).name === 'AbortError') {
          this.logger.debug('LLM streamChat 被用户中断');
          return;
        }
        this.logger.warn(
          `LLM streamChat 失败，降级到同步 chat：${(err as Error).message}`,
        );
        // 降级到同步 chat（下方统一处理）
      }
    }
    // 降级：同步 chat 一次性返回
    try {
      const result = await provider.chat(messages, opts);
      if (result?.content) {
        yield { type: 'delta', content: result.content };
      }
      yield { type: 'done' };
    } catch (err) {
      this.logger.warn(
        `LLM streamChat 降级 chat 也失败（provider=${provider.name}）：${(err as Error).message}`,
      );
      yield { type: 'error', message: '生成失败，请稍后重试' };
    }
  }

  /** 类型守卫：判断 Provider 是否实现 LlmStreamProvider */
  private isStreamProvider(p: LlmProvider): p is LlmStreamProvider {
    return typeof (p as LlmStreamProvider).streamChat === 'function';
  }
}

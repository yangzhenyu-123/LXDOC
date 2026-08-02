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
   *
   * @deprecated 用 getActiveProviders() 替代（R3 fallback 链）。保留单数版本仅为兼容旧调用
   */
  getActiveProvider(): LlmProvider | null {
    return this.providers.find((p) => p.isReady()) ?? null;
  }

  /**
   * 所有就绪的 Provider（R3 fallback 链用）
   *
   * chat / streamChat 遍历此数组，主 Provider 失败时自动切下一个。
   * 当前只有 1 个 GlmProvider，未来加第二个 Provider（如 Anthropic）只需注册到 LLM_PROVIDERS，
   * 即可获得 fallback 能力，无需改业务层。
   *
   * @returns 就绪 Provider 数组（按注册顺序），空数组表示无可用 Provider
   */
  getActiveProviders(): LlmProvider[] {
    return this.providers.filter((p) => p.isReady());
  }

  /**
   * 是否就绪（至少一个 Provider 可用）
   */
  isReady(): boolean {
    return this.getActiveProviders().length > 0;
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
    const active = this.getActiveProviders();
    return {
      ready: active.length > 0,
      activeProvider: active[0]?.name ?? null,
      providers: list,
    };
  }

  /**
   * 同步对话（降级返回 null）
   *
   * R3 fallback 链：遍历所有就绪 Provider，主 Provider 抛错时自动切下一个。
   * 所有 Provider 都失败才返回 null。当前只有 1 个 GlmProvider，未来加 Provider 即获 fallback。
   *
   * 业务层据返回值决定是否启用 AI 功能
   */
  async chat(
    messages: LlmMessage[],
    opts?: LlmChatOptions,
  ): Promise<LlmChatResult | null> {
    const providers = this.getActiveProviders();
    if (providers.length === 0) {
      this.logger.debug('LLM 未就绪，chat 降级返回 null');
      return null;
    }
    let lastErr: Error | null = null;
    for (const provider of providers) {
      try {
        return await provider.chat(messages, opts);
      } catch (err) {
        lastErr = err as Error;
        this.logger.warn(
          `LLM chat 失败（provider=${provider.name}），尝试下一个：${(err as Error).message}`,
        );
      }
    }
    this.logger.error(`所有 Provider chat 均失败：${lastErr?.message}`);
    return null;
  }

  /**
   * 向量嵌入（降级返回 null）
   *
   * R3 fallback 链：遍历所有就绪 Provider，主 Provider 不支持/失败时切下一个。
   * Provider 不支持 embedding 时跳过（不视为失败），所有 Provider 都不支持才返回 null。
   */
  async embed(text: string, model?: string): Promise<LlmEmbedResult | null> {
    const providers = this.getActiveProviders();
    if (providers.length === 0) return null;
    for (const provider of providers) {
      try {
        return await provider.embed(text, model);
      } catch (err) {
        if (err instanceof LlmNotSupportedException) {
          // 不支持 embedding 静默跳过，尝试下一个
          this.logger.debug(
            `Provider ${provider.name} 不支持 embedding，跳过：${err.message}`,
          );
          continue;
        }
        this.logger.warn(
          `LLM embed 失败（provider=${provider.name}），尝试下一个：${(err as Error).message}`,
        );
      }
    }
    return null;
  }

  /**
   * 流式对话（降级：Provider 不支持流式时回退到同步 chat，一次性产出完整内容）
   *
   * R3 fallback 链：遍历所有就绪 Provider，主 Provider 流式失败时切下一个。
   * 注意：流式已开始产出 token 后失败不切（会导致内容重复），仅在首次连接失败时切。
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
    const providers = this.getActiveProviders();
    if (providers.length === 0) {
      this.logger.debug('LLM 未就绪，streamChat 降级返回空');
      yield { type: 'error', message: 'AI 服务未启用' };
      return;
    }
    let lastErr: Error | null = null;
    for (const provider of providers) {
      // 支持 LlmStreamProvider 接口时走原生流式
      if (this.isStreamProvider(provider)) {
        try {
          yield* provider.streamChat(messages, opts);
          return; // 成功完成，不切下一个
        } catch (err) {
          // 用户中断（AbortError）不算错误，静默结束
          if ((err as Error).name === 'AbortError') {
            this.logger.debug('LLM streamChat 被用户中断');
            return;
          }
          lastErr = err as Error;
          this.logger.warn(
            `LLM streamChat 失败（provider=${provider.name}），尝试下一个：${(err as Error).message}`,
          );
          // 继续尝试下一个 provider（下方循环）
          continue;
        }
      }
      // 不支持流式：降级到同步 chat（一次性返回）
      try {
        const result = await provider.chat(messages, opts);
        if (result?.content) {
          yield { type: 'delta', content: result.content };
        }
        yield { type: 'done' };
        return;
      } catch (err) {
        lastErr = err as Error;
        this.logger.warn(
          `LLM chat 降级也失败（provider=${provider.name}），尝试下一个：${(err as Error).message}`,
        );
        continue;
      }
    }
    // 所有 provider 都失败
    this.logger.error(`所有 Provider streamChat 均失败：${lastErr?.message}`);
    yield { type: 'error', message: '生成失败，请稍后重试' };
  }

  /** 类型守卫：判断 Provider 是否实现 LlmStreamProvider */
  private isStreamProvider(p: LlmProvider): p is LlmStreamProvider {
    return typeof (p as LlmStreamProvider).streamChat === 'function';
  }
}

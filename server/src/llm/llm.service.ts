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
} from './llm-provider.interface';

/**
 * LLM 编排服务
 *
 * 职责：
 * 1. 聚合所有 Provider，选择首个 isReady() 的作为活跃 Provider
 * 2. 暴露统一入口 chat/embed/health，业务模块只依赖 LlmService（不直接依赖 Provider）
 * 3. 失败/未启用时降级：chat 返回 null，embed 返回 null，不抛错（除非显式要求）
 *
 * 业务接入示例（后续迭代）：
 *   constructor(@OptionalLlm() private llm?: LlmService) {}
 *   async summarize(text) { return (await this.llm?.chat(...))?.content ?? null; }
 *
 * 本期仅骨架，无实际业务调用方。
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
}

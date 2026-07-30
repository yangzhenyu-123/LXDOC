import { Injectable, Logger } from '@nestjs/common';
import {
  LlmChatOptions,
  LlmChatResult,
  LlmEmbedResult,
  LlmMessage,
  LlmNotSupportedException,
  LlmProvider,
} from '../llm-provider.interface';
import { llmConfig } from '../../config/llm.config';

/**
 * GLM Provider（内网 GLM5.2，OpenAI 兼容接口）
 *
 * 假设内网 GLM 提供：
 * - POST {baseUrl}/chat/completions  (OpenAI 兼容)
 * - POST {baseUrl}/embeddings        (可选，若无则 embed 抛 NotSupportedException)
 *
 * 认证：Authorization: Bearer <apiKey>（apiKey 为空时跳过头）
 * 超时：LlmChatOptions.timeout 优先，否则用 llmConfig.timeout
 * 重试：网络错误/5xx 最多重试 llmConfig.maxRetries 次，指数退避 500ms/1s/...
 *
 * 本期仅实现骨架，未配置（LLM_ENABLED=false）时 isReady() 返回 false，
 * LlmService 会跳过该 Provider，业务降级返回 null。
 */
@Injectable()
export class GlmProvider implements LlmProvider {
  private readonly logger = new Logger(GlmProvider.name);
  readonly name = 'glm';

  isReady(): boolean {
    return llmConfig.enabled && !!llmConfig.baseUrl;
  }

  async chat(
    messages: LlmMessage[],
    opts?: LlmChatOptions,
  ): Promise<LlmChatResult> {
    if (!this.isReady()) {
      throw new LlmNotSupportedException('GLM 未启用或未配置 baseUrl');
    }
    const model = opts?.model ?? llmConfig.model;
    const url = `${llmConfig.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model,
      messages,
      temperature: opts?.temperature ?? 0.7,
      ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    };
    const data = await this.requestWithRetry(url, body, opts?.timeout);
    const choice = data?.choices?.[0]?.message?.content ?? '';
    return {
      content: choice,
      model: data?.model ?? model,
      promptTokens: data?.usage?.prompt_tokens,
      completionTokens: data?.usage?.completion_tokens,
    };
  }

  async embed(text: string, model?: string): Promise<LlmEmbedResult> {
    if (!this.isReady()) {
      throw new LlmNotSupportedException('GLM 未启用或未配置 baseUrl');
    }
    const useModel = model ?? llmConfig.embedModel;
    if (!useModel) {
      throw new LlmNotSupportedException(
        '未配置 LLM_EMBED_MODEL，向量检索不可用',
      );
    }
    const url = `${llmConfig.baseUrl.replace(/\/$/, '')}/embeddings`;
    const body = { model: useModel, input: text };
    const data = await this.requestWithRetry(url, body, undefined);
    const vector: number[] = data?.data?.[0]?.embedding ?? [];
    return {
      vector,
      model: data?.model ?? useModel,
      tokens: data?.usage?.total_tokens,
    };
  }

  /**
   * 带重试的 POST 请求
   * - 网络错误/5xx：最多重试 maxRetries 次，指数退避
   * - 4xx：直接抛错（参数错误不重试）
   * - 超时：通过 AbortController 实现
   */
  private async requestWithRetry(
    url: string,
    body: unknown,
    timeoutOverride?: number,
  ): Promise<any> {
    const maxRetries = llmConfig.maxRetries;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.requestOnce(url, body, timeoutOverride);
      } catch (err: any) {
        lastErr = err;
        const status = err?.status;
        // 4xx 客户端错误不重试
        if (typeof status === 'number' && status >= 400 && status < 500) {
          throw err;
        }
        if (attempt < maxRetries) {
          const delay = 500 * 2 ** attempt;
          this.logger.warn(
            `GLM 请求失败 attempt=${attempt + 1}，${delay}ms 后重试：${err?.message ?? err}`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  private async requestOnce(
    url: string,
    body: unknown,
    timeoutOverride?: number,
  ): Promise<any> {
    const timeout = timeoutOverride ?? llmConfig.timeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (llmConfig.apiKey) {
        headers.Authorization = `Bearer ${llmConfig.apiKey}`;
      }
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        const err: Error & { status?: number } = new Error(
          `GLM HTTP ${resp.status}: ${text.slice(0, 200)}`,
        );
        err.status = resp.status;
        throw err;
      }
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import {
  LlmChatOptions,
  LlmChatResult,
  LlmEmbedResult,
  LlmMessage,
  LlmNotSupportedException,
  LlmProvider,
  LlmStreamChunk,
  LlmStreamProvider,
} from '../llm-provider.interface';
import { llmConfig } from '../../config/llm.config';
import { parseSseLine, isDataLine } from './glm-sse.utils';

/**
 * GLM Provider（内网 GLM5.2，OpenAI 兼容接口）
 *
 * 假设内网 GLM 提供：
 * - POST {baseUrl}/chat/completions  (OpenAI 兼容，支持 stream=true)
 * - POST {baseUrl}/embeddings        (可选，若无则 embed 抛 NotSupportedException)
 *
 * 认证：Authorization: Bearer <apiKey>（apiKey 为空时跳过头）
 * 超时：LlmChatOptions.timeout 优先，否则用 llmConfig.timeout
 * 重试：网络错误/5xx 最多重试 llmConfig.maxRetries 次，指数退避 500ms/1s/...
 *
 * 流式（streamChat）：
 * - 请求 stream=true，响应为 SSE 行 "data: {json}\n\n"
 * - 解析 delta.reasoning_content（GLM-5.2 思考链）和 delta.content（正文）
 * - 识别 "[DONE]" 终止标记
 * - 支持 AbortSignal 中断
 *
 * 本期仅实现骨架，未配置（LLM_ENABLED=false）时 isReady() 返回 false，
 * LlmService 会跳过该 Provider，业务降级返回 null。
 */
@Injectable()
export class GlmProvider implements LlmProvider, LlmStreamProvider {
  private readonly logger = new Logger(GlmProvider.name);
  readonly name = 'glm';

  isReady(): boolean {
    return llmConfig.enabled && !!llmConfig.baseUrl;
  }

  async chat(
    messages: LlmMessage[],
    opts?: LlmChatOptions,
  ): Promise<LlmChatResult> {
    // 支持通过 opts 覆盖连接配置（admin 配多套 LLM 时按用户选择注入）
    const baseUrl = opts?.baseUrl ?? llmConfig.baseUrl;
    const apiKey = opts?.apiKey ?? llmConfig.apiKey;
    // 有覆盖时即使全局未启用也可调用（多套配置场景）
    if (!opts?.baseUrl && !this.isReady()) {
      throw new LlmNotSupportedException('GLM 未启用或未配置 baseUrl');
    }
    if (!baseUrl) {
      throw new LlmNotSupportedException('GLM 未配置 baseUrl');
    }
    const model = opts?.model ?? llmConfig.model;
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts?.temperature ?? 0.7,
      ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    };
    // 推理模型（GLM-5.2）支持通过 chat_template_kwargs.enable_thinking 关闭推理。
    // 显式传 enableThinking=false 时关闭（简单任务如路径生成/标签），否则保持默认（开启推理）。
    // 不支持该参数的模型会忽略此字段，无副作用。
    if (opts?.enableThinking === false) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    const data = await this.requestWithRetry(url, body, opts?.timeout, apiKey);
    const choice = data?.choices?.[0]?.message?.content ?? '';
    return {
      content: choice,
      model: data?.model ?? model,
      promptTokens: data?.usage?.prompt_tokens,
      completionTokens: data?.usage?.completion_tokens,
    };
  }

  /**
   * 流式对话：异步生成器逐块产出
   *
   * 请求 GLM /chat/completions with stream=true，解析 SSE 行：
   * - delta.reasoning_content → yield { type: 'reasoning', content }
   * - delta.content           → yield { type: 'delta', content }
   * - "[DONE]"                → yield { type: 'done' } 并结束
   *
   * 支持中断：opts.signal 触发 abort 后，fetch 抛 AbortError，生成器终止。
   * 错误处理：4xx 直接抛错；5xx/网络错误不重试（流式重试会重复输出，由调用方处理）。
   */
  async *streamChat(
    messages: LlmMessage[],
    opts?: LlmChatOptions & { signal?: AbortSignal },
  ): AsyncGenerator<LlmStreamChunk, void, unknown> {
    const baseUrl = opts?.baseUrl ?? llmConfig.baseUrl;
    const apiKey = opts?.apiKey ?? llmConfig.apiKey;
    if (!opts?.baseUrl && !this.isReady()) {
      throw new LlmNotSupportedException('GLM 未启用或未配置 baseUrl');
    }
    if (!baseUrl) {
      throw new LlmNotSupportedException('GLM 未配置 baseUrl');
    }
    const model = opts?.model ?? llmConfig.model;
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts?.temperature ?? 0.7,
      stream: true,
      ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    };
    if (opts?.enableThinking === false) {
      body.chat_template_kwargs = { enable_thinking: false };
    }

    const timeout = opts?.timeout ?? llmConfig.timeout;
    // 合并用户 signal 和超时 signal
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onExternalAbort = () => controller.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        // 契约：已 aborted 时仍产出 done，让调用方正常结束消费
        yield { type: 'done' };
        return;
      }
      opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
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
      if (!resp.body) {
        throw new Error('GLM stream 响应无 body');
      }

      // 逐行解析 SSE：行格式 "data: {json}\n\n"，终止标记 "data: [DONE]"
      reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let done = false;
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 事件以空行分隔，按行切分
        const lines = buffer.split('\n');
        // 最后一行可能不完整，留在 buffer
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!isDataLine(line)) continue;
          const parsed = parseSseLine(line);
          for (const evt of parsed) {
            if (evt.type === 'done') {
              done = true;
              break;
            }
            yield evt;
          }
          if (done) break;
        }
      }
      yield { type: 'done' };
    } catch (err) {
      // 用户中断（AbortError）静默结束，不报错
      if ((err as Error).name === 'AbortError') {
        return;
      }
      this.logger.warn(`GLM streamChat 失败：${(err as Error).message}`);
      yield { type: 'error', message: '生成失败，请稍后重试' };
    } finally {
      clearTimeout(timer);
      // 显式释放 reader，避免连接残留
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // cancel 抛错忽略（连接已断/已读完）
        }
      }
      if (opts?.signal) {
        opts.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  async embed(text: string, model?: string): Promise<LlmEmbedResult> {
    // embedding 端点：优先用 embedBaseUrl（独立 TEI 服务），回退到 baseUrl（GLM 自带 embedding）
    const embedBaseUrl = llmConfig.embedBaseUrl;
    const baseUrl = embedBaseUrl || llmConfig.baseUrl;
    if (!baseUrl) {
      throw new LlmNotSupportedException('未配置 embedBaseUrl 或 baseUrl，向量检索不可用');
    }
    const useModel = model ?? llmConfig.embedModel;
    if (!useModel) {
      throw new LlmNotSupportedException(
        '未配置 LLM_EMBED_MODEL，向量检索不可用',
      );
    }
    const url = `${baseUrl.replace(/\/$/, '')}/embeddings`;
    const body = { model: useModel, input: text };
    // 独立 TEI 服务不需要 apiKey；回退到 GLM baseUrl 时用 llmConfig.apiKey
    const apiKey = embedBaseUrl ? undefined : llmConfig.apiKey;
    const data = await this.requestWithRetry(url, body, undefined, apiKey);
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
    apiKeyOverride?: string,
  ): Promise<any> {
    const maxRetries = llmConfig.maxRetries;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.requestOnce(url, body, timeoutOverride, apiKeyOverride);
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
    apiKeyOverride?: string,
  ): Promise<any> {
    const timeout = timeoutOverride ?? llmConfig.timeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      const key = apiKeyOverride ?? llmConfig.apiKey;
      if (key) {
        headers.Authorization = `Bearer ${key}`;
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

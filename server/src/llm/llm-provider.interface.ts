/**
 * LLM Provider 抽象接口
 *
 * 设计原则：
 * - 与具体模型解耦，GLM5.2 是其中一个实现；后续可新增 OpenAI / Claude / 本地 ollama 等实现。
 * - 仅约定最小可用能力：chat / embed；流式与工具调用为可选扩展点。
 * - 所有方法返回 Promise，失败由 Provider 内部抛错；上层 LlmService 负责降级。
 *
 * 后续分期（非本期实现）：
 * 1. 健康检查：ping(baseUrl) → boolean
 * 2. 摘要：summarize(text) → string
 * 3. 标签：suggestTags(text) → string[]
 * 4. RAG：embed(text) → number[]，结合 pgvector 语义检索
 * 5. 对话：streamChat(messages) → AsyncGenerator<string>
 */

/**
 * 对话消息角色
 */
export type LlmRole = 'system' | 'user' | 'assistant';

/**
 * 多模态消息内容片段（OpenAI 兼容格式）
 * - text：纯文本片段
 * - image_url：图片片段，url 可为 http(s) URL 或 data URI（base64）
 */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * 对话消息（OpenAI 兼容格式）
 *
 * content 类型：
 * - string：纯文本消息（绝大多数场景，向后兼容）
 * - LlmContentPart[]：多模态消息（含图片时用，vision 模型支持）
 *
 * GlmProvider 直接 JSON.stringify 传给端点（vLLM/SGLang 原生支持 OpenAI 多模态格式）。
 */
export interface LlmMessage {
  role: LlmRole;
  content: string | LlmContentPart[];
}

/**
 * 对话请求参数
 */
export interface LlmChatOptions {
  /** 模型名，省略用 Provider 默认 */
  model?: string;
  /** 温度，0~2，默认 0.7 */
  temperature?: number;
  /** 最大输出 token 数 */
  maxTokens?: number;
  /** 超时（毫秒），覆盖配置 */
  timeout?: number;
  /**
   * 是否启用推理（thinking/reasoning）模式，默认 true。
   * 推理模型（如 GLM-5.2）开启时会先输出 reasoning_content 再输出 content，
   * 适合复杂任务（总结、分析）；简单任务（分类路径、标签生成）可设为 false
   * 跳过推理直接输出，省 token 且响应更快。
   * 不支持推理的 Provider 忽略此选项。
   */
  enableThinking?: boolean;
  /**
   * 强制使用 vision（多模态）模型，用于含图片消息的场景。
   * - true：Provider 切到 visionModel / visionBaseUrl / visionApiKey（未配置时回退默认 + warn）
   * - 省略/false：消息含 image_url 片段时 Provider 也自动识别并切换
   * 业务层通常无需显式设置；由 GlmProvider 内部检测消息内容决定。
   */
  vision?: boolean;
  /**
   * 连接覆盖（admin 配置多套 LLM 时，按用户选择的 LlmConfig 注入）。
   * 省略时 Provider 使用全局 llmConfig。
   */
  baseUrl?: string;
  apiKey?: string;
}

/**
 * 流式 chunk 类型
 * - reasoning：推理模型的思考链增量（GLM-5.2 的 reasoning_content）
 * - delta：正文增量（OpenAI delta.content）
 * - error：流式过程中发生错误（降级也失败时下发，调用方据此向用户报错）
 * - done：流结束
 *
 * 注：error 后流终止，不再产出 done；调用方收到 error 即应结束消费。
 */
export type LlmStreamChunk =
  | { type: 'reasoning'; content: string }
  | { type: 'delta'; content: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

/**
 * 对话响应
 */
export interface LlmChatResult {
  /** 模型输出文本 */
  content: string;
  /** 本次消耗的 prompt token 数（若 Provider 返回） */
  promptTokens?: number;
  /** 本次消耗的 completion token 数（若 Provider 返回） */
  completionTokens?: number;
  /** 实际使用的模型名 */
  model: string;
}

/**
 * 向量嵌入响应
 */
export interface LlmEmbedResult {
  /** 向量（维度由模型决定，存入 pgvector 前需固定） */
  vector: number[];
  /** 实际使用的模型名 */
  model: string;
  /** token 数（若 Provider 返回） */
  tokens?: number;
}

/**
 * LLM Provider 接口
 * 每个具体模型实现此接口，注册到 LlmModule
 */
export interface LlmProvider {
  /** Provider 唯一标识（如 'glm' / 'openai'） */
  readonly name: string;

  /** 是否就绪（配置完整 + 网络可达），由 LlmService 在 health 中聚合 */
  isReady(): boolean;

  /**
   * 同步对话：发送消息，返回完整响应
   * 流式场景请实现 streamChat（可选）
   */
  chat(messages: LlmMessage[], opts?: LlmChatOptions): Promise<LlmChatResult>;

  /**
   * 向量嵌入：将文本转为向量，供 RAG 检索
   * 内网若不提供 embedding 接口，实现应抛 NotSupportedException，
   * LlmService 据此禁用向量检索相关功能
   */
  embed(text: string, model?: string): Promise<LlmEmbedResult>;
}

/**
 * 流式对话能力（可选）
 * 支持 OpenAI 兼容 stream API 的 Provider 实现此接口，
 * LlmService.streamChat 优先调用，不支持时回退到 chat（非流式）。
 */
export interface LlmStreamProvider extends LlmProvider {
  /**
   * 流式对话：异步生成器逐块产出
   * - chunk.type='reasoning'：推理模型的思考链增量（GLM-5.2 的 reasoning_content）
   * - chunk.type='delta'：正文增量
   * - chunk.type='error'：流式过程发生错误（降级也失败时下发）
   * - chunk.type='done'：流正常结束（最后必产出一个；error 后不再产出 done）
   *
   * 实现要点：
   * 1. 请求 /chat/completions with stream: true
   * 2. 解析 SSE 行 "data: {json}"，识别 "[DONE]" 终止
   * 3. 分离 delta.reasoning_content 和 delta.content
   * 4. 支持 AbortSignal（opts.signal）中断
   */
  streamChat(
    messages: LlmMessage[],
    opts?: LlmChatOptions & { signal?: AbortSignal },
  ): AsyncGenerator<LlmStreamChunk, void, unknown>;
}

/**
 * LLM Provider DI token
 * LlmModule 把所有 Provider 注册到此 token，LlmService 通过 @Inject(LLM_PROVIDERS) 拿到数组
 */
export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS');

/**
 * 不支持的操作（如内网 GLM 不提供 embedding）
 * 业务层捕获此错误后降级，不阻断主流程
 */
export class LlmNotSupportedException extends Error {
  constructor(message = '当前 LLM Provider 不支持该操作') {
    super(message);
    this.name = 'LlmNotSupportedException';
  }
}

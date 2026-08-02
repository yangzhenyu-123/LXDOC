/**
 * LLM 接入配置
 * - enabled：是否启用 LLM（默认 false，未配置内网 GLM 时不启用）
 * - baseUrl：内网 GLM5.2 OpenAI 兼容端点（如 http://internal-glm/v1）
 * - apiKey：调用密钥（内网若无需鉴权可留空）
 * - model：默认对话模型（glm-5.2）
 * - embedBaseUrl：向量模型推理服务端点（如 TEI http://<PROD_HOST>:8081）
 * - embedModel：向量模型标识（如 BAAI/bge-m3）
 * - embedDimensions：向量维度（bge-m3 = 1024）
 * - timeout：单次请求超时（毫秒）
 *
 * 设计：所有值走 env，未配置时 enabled=false，业务模块走 @OptionalLlm() 注入并降级返回 null。
 *
 * 覆盖层：getter 优先查 SystemSettingsService 维护的内存覆盖（DB system_settings 表），
 * 再回退 process.env。admin 在线修改后立即生效，无需重启。
 *
 * 实现说明：使用 getter 而非静态赋值。
 * 若用顶层 `const x = process.env.Y` 直接读取，会在模块 import 阶段立即执行，
 * 此时 @nestjs/config 的 ConfigModule 尚未把 .env 注入 process.env，导致始终读到默认值。
 * 改为 getter 后，每次属性访问（如 llmConfig.baseUrl）都在运行时读取 process.env，
 * 确保 ConfigModule 加载 .env 后能拿到正确值。调用方式（属性访问）保持不变。
 */
import {
  getOverrideBool,
  getOverrideNumber,
  getOverrideString,
} from '../system/settings-overrides';

export const llmConfig = {
  get enabled(): boolean {
    return getOverrideBool('llm.enabled', (process.env.LLM_ENABLED ?? 'false').toLowerCase() === 'true');
  },
  get baseUrl(): string {
    return getOverrideString('llm.baseUrl', process.env.LLM_BASE_URL ?? 'http://internal-glm/v1');
  },
  get apiKey(): string {
    return getOverrideString('llm.apiKey', process.env.LLM_API_KEY ?? '');
  },
  get model(): string {
    return getOverrideString('llm.model', process.env.LLM_MODEL ?? 'glm-5.2');
  },
  get embedBaseUrl(): string {
    return getOverrideString('llm.embedBaseUrl', process.env.LLM_EMBED_BASE_URL ?? '');
  },
  get embedModel(): string {
    return getOverrideString('llm.embedModel', process.env.LLM_EMBED_MODEL ?? '');
  },
  get embedDimensions(): number {
    return getOverrideNumber('llm.embedDimensions', Number(process.env.LLM_EMBED_DIMENSIONS ?? '0') || 0);
  },
  get timeout(): number {
    return getOverrideNumber('llm.timeout', Number(process.env.LLM_TIMEOUT ?? '30000') || 30000);
  },
  // 最大重试次数（指数退避）
  get maxRetries(): number {
    return getOverrideNumber('llm.maxRetries', Number(process.env.LLM_MAX_RETRIES ?? '2') || 2);
  },
  // 总结单次投喂文本上限（字符数）。超过则截断头尾各半保留，避免超出模型上下文窗口
  // GLM5.2 上下文窗口较大，默认 80000 字符（约 4 万汉字）兼顾质量与成本
  get summaryMaxChars(): number {
    return getOverrideNumber('llm.summaryMaxChars', Number(process.env.LLM_SUMMARY_MAX_CHARS ?? '80000') || 80000);
  },
};

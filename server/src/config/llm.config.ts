/**
 * LLM 接入配置
 * - enabled：是否启用 LLM（默认 false，未配置内网 GLM 时不启用）
 * - baseUrl：内网 GLM5.2 OpenAI 兼容端点（如 http://internal-glm/v1）
 * - apiKey：调用密钥（内网若无需鉴权可留空）
 * - model：默认对话模型（glm-5.2）
 * - embedModel：向量模型（若内网提供；未提供则禁用 RAG 向量检索）
 * - timeout：单次请求超时（毫秒）
 *
 * 设计：所有值走 env，未配置时 enabled=false，业务模块走 @OptionalLlm() 注入并降级返回 null。
 */
export const llmConfig = {
  enabled:
    (process.env.LLM_ENABLED ?? 'false').toLowerCase() === 'true',
  baseUrl: process.env.LLM_BASE_URL ?? 'http://internal-glm/v1',
  apiKey: process.env.LLM_API_KEY ?? '',
  model: process.env.LLM_MODEL ?? 'glm-5.2',
  embedModel: process.env.LLM_EMBED_MODEL ?? '',
  embedDimensions: Number(process.env.LLM_EMBED_DIMENSIONS ?? '0') || 0,
  timeout: Number(process.env.LLM_TIMEOUT ?? '30000') || 30000,
  // 最大重试次数（指数退避）
  maxRetries: Number(process.env.LLM_MAX_RETRIES ?? '2') || 2,
};

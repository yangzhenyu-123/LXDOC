import client from './client';

/**
 * 当前用户的 LLM 配置（apiKey 脱敏：已配置返回 '******'，未配置返回 null）
 */
export interface MyLlmConfig {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  enableThinking: boolean;
  actAsUserId: string | null;
}

/** 更新自己的 LLM 配置（apiKey 传 '******' 或省略表示不修改） */
export interface UpdateMyLlmConfigPayload {
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  enableThinking?: boolean;
  actAsUserId?: string | null;
}

/** admin: 用户 LLM 配置概览 */
export interface UserLlmOverview {
  id: string;
  username: string;
  email: string;
  role: string;
  llmBaseUrl: string | null;
  llmModel: string | null;
  llmApiKeyConfigured: boolean;
  llmEnableThinking: boolean;
  llmActAsUserId: string | null;
}

/** admin: 可被代理的用户 */
export interface ActAsCandidate {
  id: string;
  username: string;
  email: string;
  role: string;
}

// ---------- 用户自配 LLM ----------

/** 获取自己的 LLM 配置（apiKey 脱敏） */
export function getMyLlmConfig(): Promise<MyLlmConfig> {
  return client.get<MyLlmConfig, MyLlmConfig>('/llm/my-config');
}

/** 更新自己的 LLM 配置 */
export function updateMyLlmConfig(
  payload: UpdateMyLlmConfigPayload,
): Promise<void> {
  return client.put<void, void>('/llm/my-config', payload);
}

// ---------- admin: 用户 LLM 配置管理 ----------

/** admin: 所有用户的 LLM 配置概览 */
export function listUsersLlmOverview(): Promise<UserLlmOverview[]> {
  return client.get<UserLlmOverview[], UserLlmOverview[]>('/llm/users-overview');
}

/** admin: 可被代理的用户列表 */
export function listActAsCandidates(): Promise<ActAsCandidate[]> {
  return client.get<ActAsCandidate[], ActAsCandidate[]>('/llm/act-as-candidates');
}

# LLM 接入

本文描述 LXDOC 的 LLM 架构设计、GLM5.2 接入方式与后续规划。当前为**架构骨架**，未接入业务功能，待内网 GLM 端点确认后启用。

## 设计目标

- **Provider 抽象**：与具体模型解耦，GLM5.2 是一个实现；后续可新增 OpenAI / Claude / 本地 ollama 等
- **可选启用**：未配置时 `LLM_ENABLED=false`，业务模块通过 `@OptionalLlm()` 注入并降级返回 null，不报错
- **失败降级**：LLM 调用失败不阻断主流程（异步任务）
- **预留扩展点**：RAG 向量检索、编辑器助手、摘要标签等后续迭代

## 模块结构

```
server/src/llm/
├── llm-provider.interface.ts    # Provider 抽象接口 + 类型定义 + DI token
├── llm.service.ts               # 编排层：选 Provider、降级、health 聚合
├── llm.controller.ts            # GET /api/llm/health（admin）
├── llm.module.ts                # 注册 Provider 数组 + LlmService
├── optional-llm.decorator.ts    # @OptionalLlm() 参数装饰器
└── providers/
    └── glm.provider.ts          # GLM5.2 OpenAI 兼容实现
```

配置：`server/src/config/llm.config.ts`。

## Provider 接口

`LlmProvider` 约定最小可用能力：

```ts
interface LlmProvider {
  readonly name: string;          // 'glm' / 'openai' / ...
  isReady(): boolean;             // 配置完整 + 启用
  chat(messages, opts?): Promise<LlmChatResult>;     // 同步对话
  embed(text, model?): Promise<LlmEmbedResult>;       // 向量嵌入（可选）
}
```

- `chat`：发送消息数组，返回完整响应（含 token 用量）
- `embed`：文本转向量；Provider 不支持时抛 `LlmNotSupportedException`，`LlmService` 据此禁用 RAG
- 流式对话（`streamChat`）为后续扩展点，本期未实现

## GLM5.2 Provider

`providers/glm.provider.ts` 假设内网 GLM 提供 OpenAI 兼容接口：

- `POST {LLM_BASE_URL}/chat/completions`
- `POST {LLM_BASE_URL}/embeddings`（可选）

特性：

- 认证：`Authorization: Bearer <LLM_API_KEY>`（apiKey 为空时跳过）
- 超时：`AbortController` + `LLM_TIMEOUT`（默认 30s）
- 重试：网络错误 / 5xx 最多 `LLM_MAX_RETRIES` 次，指数退避 500ms/1s/...
- 4xx 客户端错误不重试（参数错误）

`isReady()` 判断：`LLM_ENABLED=true` 且 `LLM_BASE_URL` 非空。

## LlmService（编排层）

业务模块只依赖 `LlmService`，不直接依赖 Provider：

| 方法 | 行为 |
|---|---|
| `getActiveProvider()` | 返回首个 `isReady()` 的 Provider，无则 null |
| `isReady()` | 是否至少一个 Provider 可用 |
| `health()` | 各 Provider 就绪状态（供 `/api/llm/health`） |
| `chat(messages, opts)` | 调活跃 Provider，失败/未启用返回 **null**（不抛错） |
| `embed(text, model)` | 同上；Provider 不支持 embedding 也返回 null |

## 业务接入方式

业务模块按需注入，LLM 未启用时自动降级：

```ts
import { OptionalLlm } from '../llm/optional-llm.decorator';
import { LlmService } from '../llm/llm.service';

@Injectable()
export class DocumentAiService {
  constructor(@OptionalLlm() private llm?: LlmService) {}

  async summarize(text: string): Promise<string | null> {
    if (!this.llm) return null;                    // LLM 模块未导入
    const result = await this.llm.chat([
      { role: 'system', content: '用 200 字总结以下文档' },
      { role: 'user', content: text },
    ]);
    return result?.content ?? null;                // 未启用/失败均返回 null
  }
}
```

模块需 `imports: [LlmModule]`。`@OptionalLlm()` 通过 `@Inject(LlmService) + @Optional()` 实现，LlmModule 未导入时参数为 undefined。

## 健康检查

`GET /api/llm/health`（仅 admin）：

```json
{
  "ready": true,
  "activeProvider": "glm",
  "providers": [
    { "name": "glm", "ready": true }
  ],
  "config": {
    "enabled": true,
    "baseUrl": "http://internal-glm/v1",
    "model": "glm-5.2",
    "embedModel": null,
    "embedDimensions": null,
    "timeout": 30000
  }
}
```

`apiKey` 不返回（脱敏）。

## 启用步骤

待内网 GLM5.2 端点确认后：

1. 在 `server/.env`（或 docker-compose environment）配置：
   ```
   LLM_ENABLED=true
   LLM_BASE_URL=http://internal-glm/v1
   LLM_API_KEY=<密钥，无则留空>
   LLM_MODEL=glm-5.2
   ```
2. 若内网提供 embedding 接口，补充：
   ```
   LLM_EMBED_MODEL=<向量模型名>
   LLM_EMBED_DIMENSIONS=<维度，与 pgvector 列对齐>
   ```
3. 重启后端，调 `GET /api/llm/health` 确认 `ready=true`
4. 业务模块按需接入（见下文规划）

## 后续规划（非本期）

### 第一期：连通性

- LLM 模块 + GLM Provider + 健康检查 ✅（已完成骨架）
- 待内网端点确认后启用

### 第二期：上传后 AI 处理

- 上传文档后异步生成摘要（写 `Document.summary` 新字段）
- 自动建议标签（写入 `tags`）
- 失败不阻断上传主流程

### 第三期：RAG 向量检索

- 启用 `pgvector` 扩展
- `Document.embedding vector(N)` 字段
- 上传/更新后异步生成 embedding
- 语义检索 + 带引用问答（SSE 流式）
- 依赖 `LLM_EMBED_MODEL` 配置，未提供则跳过

### 第四期：编辑器内助手

- 侧栏对话（基于文档上下文）
- 补全建议
- 选中改写

## 待确认信息

接入前需向内网 GLM 团队确认：

- 内网 GLM5.2 端点 URL 与是否 OpenAI 兼容
- 认证方式（API Key / 内网免鉴权 / 其他）
- 是否提供 embedding 接口及其维度
- 上下文窗口大小
- 并发与限流策略（QPS / TPM）
- 是否需要走内网代理
- 模型名是否为 `glm-5.2`（或其他具体版本号）

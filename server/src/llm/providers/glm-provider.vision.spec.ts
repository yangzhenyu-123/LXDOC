/**
 * GlmProvider vision 路由单元测试
 *
 * 覆盖 resolveConnection 路由逻辑（chat 入口）：
 * 1. 默认：用 llmConfig.baseUrl/apiKey/model
 * 2. opts.baseUrl 显式覆盖（admin 多套 LLM）
 * 3. 消息含 image_url 片段 → 切 visionModel + visionBaseUrl（留空回退 baseUrl）
 * 4. opts.vision=true → 同 3
 * 5. vision 未配置（visionModel 空）+ 消息含图 → 回退默认 model + warn
 * 6. opts.model 覆盖但 baseUrl/apiKey 走默认
 *
 * fetch 用全局 mock，避免真实网络调用。
 * llmConfig 用 jest.mock 工厂返回对象，测试中通过 require 拿引用并 Object.assign 改字段。
 */
import { GlmProvider } from './glm.provider';
import { LlmMessage } from '../llm-provider.interface';

// jest.mock 工厂内不引用外部变量，返回固定对象；测试中通过 require 拿引用修改字段
jest.mock('../../config/llm.config', () => ({
  llmConfig: {
    enabled: true,
    baseUrl: 'http://default-glm/v1',
    apiKey: 'default-key',
    model: 'glm-5.2',
    visionModel: '',
    visionBaseUrl: '',
    visionApiKey: '',
    visionMaxImages: 5,
    visionMaxImageBytes: 2 * 1024 * 1024,
    timeout: 30000,
    maxRetries: 0,
    embedBaseUrl: '',
    embedModel: '',
    embedDimensions: 0,
    rerankBaseUrl: '',
    rerankModel: '',
    rerankCandidateK: 20,
    summaryMaxChars: 80000,
  },
}));

// 全局 fetch mock
const fetchMock = jest.fn() as jest.Mock;
(globalThis as any).fetch = fetchMock;

// 拿到 mock 后的 llmConfig 引用（用于测试中改字段）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { llmConfig: mockConfig } = require('../../config/llm.config');

function mockResp(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** 抓取最后一次 fetch 调用的 body 参数（JSON 解析） */
function lastFetchBody(): Record<string, unknown> {
  const last = fetchMock.mock.calls.at(-1);
  expect(last).toBeTruthy();
  const init = last![1] as { body?: string };
  return JSON.parse(init.body ?? '{}');
}

function textMsg(content: string): LlmMessage {
  return { role: 'user', content };
}

function visionMsg(content: string, dataUri = 'data:image/png;base64,AAA'): LlmMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: content },
      { type: 'image_url', image_url: { url: dataUri } },
    ],
  };
}

describe('GlmProvider vision 路由', () => {
  let provider: GlmProvider;

  beforeEach(() => {
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(mockResp({
      choices: [{ message: { content: 'ok' } }],
      model: 'mock',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    // 重置 mock config 到默认
    Object.assign(mockConfig, {
      enabled: true,
      baseUrl: 'http://default-glm/v1',
      apiKey: 'default-key',
      model: 'glm-5.2',
      visionModel: '',
      visionBaseUrl: '',
      visionApiKey: '',
    });
    provider = new GlmProvider();
  });

  it('默认：用 baseUrl/apiKey/model', async () => {
    await provider.chat([textMsg('hi')]);
    const body = lastFetchBody();
    expect(body.model).toBe('glm-5.2');
    const url = fetchMock.mock.calls.at(-1)![0];
    expect(url).toContain('http://default-glm/v1');
    const init = fetchMock.mock.calls.at(-1)![1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer default-key');
  });

  it('opts.baseUrl 显式覆盖（admin 多套 LLM）', async () => {
    await provider.chat([textMsg('hi')], {
      baseUrl: 'http://user-glm/v1',
      apiKey: 'user-key',
      model: 'glm-4.6',
    });
    const url = fetchMock.mock.calls.at(-1)![0];
    expect(url).toContain('http://user-glm/v1');
    const init = fetchMock.mock.calls.at(-1)![1] as { headers: Record<string, string>; body: string };
    expect(init.headers.Authorization).toBe('Bearer user-key');
    expect(JSON.parse(init.body).model).toBe('glm-4.6');
  });

  it('消息含 image_url 片段 → 切 visionModel + visionBaseUrl', async () => {
    mockConfig.visionModel = 'qwen3.6-35b-a3b';
    mockConfig.visionBaseUrl = 'http://vision-host/v1';
    mockConfig.visionApiKey = 'vision-key';
    await provider.chat([visionMsg('看图')]);
    const url = fetchMock.mock.calls.at(-1)![0];
    expect(url).toContain('http://vision-host/v1');
    const init = fetchMock.mock.calls.at(-1)![1] as { headers: Record<string, string>; body: string };
    expect(init.headers.Authorization).toBe('Bearer vision-key');
    expect(JSON.parse(init.body).model).toBe('qwen3.6-35b-a3b');
  });

  it('消息含 image_url + visionBaseUrl 留空 → 复用 baseUrl', async () => {
    mockConfig.visionModel = 'qwen3.6-35b-a3b';
    // visionBaseUrl / visionApiKey 留空
    await provider.chat([visionMsg('看图')]);
    const url = fetchMock.mock.calls.at(-1)![0];
    expect(url).toContain('http://default-glm/v1');
    const init = fetchMock.mock.calls.at(-1)![1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer default-key');
  });

  it('opts.vision=true 强制切 vision 模型', async () => {
    mockConfig.visionModel = 'qwen3.6-35b-a3b';
    mockConfig.visionBaseUrl = 'http://vision/v1';
    // 纯文本消息 + opts.vision=true 也应切
    await provider.chat([textMsg('需要 vision 模型回答')], { vision: true });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).model).toBe('qwen3.6-35b-a3b');
  });

  it('vision 未配置 + 消息含图 → 回退默认 model + warn', async () => {
    // visionModel 保持空
    await provider.chat([visionMsg('看图')]);
    const body = lastFetchBody();
    expect(body.model).toBe('glm-5.2'); // 回退默认
    // 仍走默认 baseUrl
    const url = fetchMock.mock.calls.at(-1)![0];
    expect(url).toContain('http://default-glm/v1');
  });

  it('opts.model 覆盖但 baseUrl/apiKey 走默认', async () => {
    await provider.chat([textMsg('hi')], { model: 'custom-model' });
    const url = fetchMock.mock.calls.at(-1)![0];
    expect(url).toContain('http://default-glm/v1');
    expect(lastFetchBody().model).toBe('custom-model');
  });

  it('streamChat 含图消息也切 vision', async () => {
    mockConfig.visionModel = 'qwen3.6-35b-a3b';
    mockConfig.visionBaseUrl = 'http://vision/v1';
    // mock 流式响应（直接 done）
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          cancel: async () => {},
        }),
      },
    });
    const chunks: any[] = [];
    for await (const c of provider.streamChat([visionMsg('看图')])) {
      chunks.push(c);
    }
    const url = fetchMock.mock.calls.at(-1)![0];
    expect(url).toContain('http://vision/v1');
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).model).toBe('qwen3.6-35b-a3b');
  });
});

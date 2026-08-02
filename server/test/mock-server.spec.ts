/**
 * mock-server 验证测试
 * 确认 GLM SSE + TEI embedding mock 服务能正常起停、响应、配置。
 * 这是集成测试的基础设施验证。
 */
import { startMockServer, MockServer } from './mock-server';

describe('mock-server', () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await startMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it('启动并监听随机端口', () => {
    expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('GLM /chat/completions 返回默认 [DONE]', async () => {
    const resp = await fetch(`${mock.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [] }),
    });
    expect(resp.ok).toBe(true);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    const text = await resp.text();
    expect(text).toContain('data: [DONE]');
  });

  it('setChatResponse 配置 delta + reasoning + done', async () => {
    mock.setChatResponse([
      { type: 'reasoning', content: '思考' },
      { type: 'delta', content: '答案' },
      { type: 'done' },
    ]);
    const resp = await fetch(`${mock.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    const text = await resp.text();
    expect(text).toContain('reasoning_content');
    expect(text).toContain('思考');
    expect(text).toContain('"content":"答案"');
    expect(text).toContain('[DONE]');
  });

  it('setChatError 返回 HTTP 错误', async () => {
    mock.setChatError(500, 'GLM 内部错误');
    const resp = await fetch(`${mock.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { error: { message: string } };
    expect(body.error.message).toBe('GLM 内部错误');
  });

  it('记录请求 body 和 authorization', async () => {
    mock.setChatResponse([{ type: 'done' }]);
    await fetch(`${mock.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Q' }] }),
    });
    const reqs = mock.getChatRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].body.messages[0].content).toBe('Q');
    expect(reqs[0].authorization).toBe('Bearer test-key');
  });

  it('TEI /embeddings 返回向量', async () => {
    mock.setEmbeddingVector([0.1, 0.2, 0.3]);
    const resp = await fetch(`${mock.url}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', input: '文本' }),
    });
    const body = (await resp.json()) as { data: Array<{ embedding: number[] }>; model: string };
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(body.model).toBe('bge-m3');
    expect(mock.getEmbedRequests()).toHaveLength(1);
  });

  it('reset 清空请求日志和配置', async () => {
    mock.setChatResponse([{ type: 'done' }]);
    await fetch(`${mock.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(mock.getChatRequests()).toHaveLength(1);
    mock.reset();
    expect(mock.getChatRequests()).toHaveLength(0);
    // reset 后返回默认 [DONE]
    const resp = await fetch(`${mock.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    const text = await resp.text();
    expect(text).toContain('[DONE]');
  });

  it('setChunkDelay 引入延迟', async () => {
    mock.setChatResponse([
      { type: 'delta', content: 'A' },
      { type: 'delta', content: 'B' },
      { type: 'done' },
    ]);
    mock.setChunkDelay(50);
    const start = Date.now();
    const resp = await fetch(`${mock.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    // 必须读完整 body 才能测出全 chunk 传输时间（fetch 只等 headers）
    await resp.text();
    const elapsed = Date.now() - start;
    // 3 chunks × 50ms = 150ms，留 30ms 容差
    expect(elapsed).toBeGreaterThanOrEqual(120);
  });
});

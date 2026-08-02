/**
 * GLM + TEI mock HTTP 服务（集成测试用）
 *
 * 起一个 express 服务，模拟两个外部依赖：
 * - POST /chat/completions —— GLM 流式对话，返回可配置的 SSE chunks
 * - POST /embeddings —— TEI embedding，返回可配置的向量
 *
 * 测试通过 setChatResponse / setEmbeddingVector 等控制下次响应，
 * 通过 getChatRequests 查询收到的请求做断言。
 *
 * 使用：
 *   const mock = await startMockServer();
 *   mock.setChatResponse([{type:'delta',content:'答案'},{type:'done'}]);
 *   // ... 跑测试，GLM provider 调 mock.url/chat/completions
 *   expect(mock.getChatRequests()).toHaveLength(1);
 *   await mock.close();
 */
import express from 'express';
import type { Server } from 'http';

/** SSE chunk 类型（对应 LlmStreamChunk） */
export type MockChunk =
  | { type: 'reasoning'; content: string }
  | { type: 'delta'; content: string }
  | { type: 'done' };

/** 错误响应配置 */
interface ErrorResponse {
  status: number;
  message: string;
}

/** Mock 服务句柄 */
export interface MockServer {
  /** 服务基础 URL，如 http://127.0.0.1:34567 */
  url: string;
  /** 关闭服务 */
  close: () => Promise<void>;
  /** 配置下次 /chat/completions 的 SSE 响应 chunks */
  setChatResponse: (chunks: MockChunk[]) => void;
  /** 配置 /chat/completions 返回 HTTP 错误（不返回 SSE） */
  setChatError: (status: number, message: string) => void;
  /** 配置每个 chunk 之间的延迟（ms，默认 0），用于测超时/中断 */
  setChunkDelay: (ms: number) => void;
  /** 配置 /embeddings 返回的向量 */
  setEmbeddingVector: (vec: number[]) => void;
  /** 配置 /embeddings 返回 HTTP 错误 */
  setEmbeddingError: (status: number, message: string) => void;
  /** 获取收到的 /chat/completions 请求列表（body + headers） */
  getChatRequests: () => Array<{ body: any; authorization?: string }>;
  /** 获取收到的 /embeddings 请求列表 */
  getEmbedRequests: () => Array<{ body: any; authorization?: string }>;
  /** 重置所有状态（chunks、错误、请求日志） */
  reset: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 启动 mock 服务（随机端口）
 * @param port 指定端口，省略则用随机空闲端口
 */
export function startMockServer(port?: number): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));

    // 可变状态（测试通过 API 控制）
    let chatChunks: MockChunk[] = [{ type: 'done' }];
    let chatError: ErrorResponse | null = null;
    let chunkDelay = 0;
    let embeddingVec: number[] = Array.from({ length: 1024 }, () => 0.01);
    let embeddingError: ErrorResponse | null = null;
    let chatRequests: Array<{ body: any; authorization?: string }> = [];
    let embedRequests: Array<{ body: any; authorization?: string }> = [];

    // GLM chat/completions SSE 端点
    app.post('/chat/completions', async (req, res) => {
      chatRequests.push({
        body: req.body,
        authorization: req.headers.authorization as string | undefined,
      });
      // 错误响应
      if (chatError) {
        res.status(chatError.status).json({ error: { message: chatError.message } });
        return;
      }
      // SSE 流式响应
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      for (const chunk of chatChunks) {
        if (chunkDelay > 0) await sleep(chunkDelay);
        if (chunk.type === 'done') {
          res.write('data: [DONE]\n\n');
        } else if (chunk.type === 'reasoning') {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: chunk.content } }] })}\n\n`);
        } else if (chunk.type === 'delta') {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk.content } }] })}\n\n`);
        }
      }
      res.end();
    });

    // TEI embeddings 端点
    app.post('/embeddings', (req, res) => {
      embedRequests.push({
        body: req.body,
        authorization: req.headers.authorization as string | undefined,
      });
      if (embeddingError) {
        res.status(embeddingError.status).json({ error: { message: embeddingError.message } });
        return;
      }
      // TEI 返回格式：{ data: [{ embedding: number[] }], model, usage }
      res.json({
        data: [{ embedding: embeddingVec }],
        model: req.body?.model ?? 'BAAI/bge-m3',
        usage: { total_tokens: 10 },
      });
    });

    const server = app.listen(port ?? 0, '127.0.0.1');
    server.on('error', reject);
    server.on('listening', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('无法获取监听地址'));
        return;
      }
      const actualPort = addr.port;
      const url = `http://127.0.0.1:${actualPort}`;
      const handle: MockServer = {
        url,
        close: () => new Promise<void>((r) => server.close(() => r())),
        setChatResponse: (chunks) => { chatChunks = chunks; chatError = null; },
        setChatError: (status, message) => { chatError = { status, message }; },
        setChunkDelay: (ms) => { chunkDelay = ms; },
        setEmbeddingVector: (vec) => { embeddingVec = vec; embeddingError = null; },
        setEmbeddingError: (status, message) => { embeddingError = { status, message }; },
        getChatRequests: () => [...chatRequests],
        getEmbedRequests: () => [...embedRequests],
        reset: () => {
          chatChunks = [{ type: 'done' }];
          chatError = null;
          chunkDelay = 0;
          embeddingVec = Array.from({ length: 1024 }, () => 0.01);
          embeddingError = null;
          chatRequests = [];
          embedRequests = [];
        },
      };
      resolve(handle);
    });
  });
}

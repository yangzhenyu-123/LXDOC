/**
 * T6 集成测试：RagService.ask 全场景
 *
 * 覆盖 9 个场景：
 * 1. 正常回答：topScore >= degradeThreshold → reasoning + delta + references + done(isFallback=false)
 * 2. 降级回答：topScore < degradeThreshold 但 >= abstainThreshold → prefix + delta + done(isFallback=true)
 * 3. 拒答：topScore < abstainThreshold → done(isFallback=true)，不调 LLM
 * 4. 中断：用户 abort → cancelled 事件
 * 5. LLM 失败：GLM 返回 error chunk → error 事件
 * 6. LLM 未启用：llmService 未就绪 → error "AI 服务未启用"
 * 7. 空 query → error "问题不能为空"
 * 8. 检索失败 → error "检索失败"
 * 9. 文档标题加载失败 → error "加载文档信息失败"
 *
 * 策略：
 * - 真实 GlmProvider + mock-server（测真实 SSE 解析 + AbortSignal + reader.cancel）
 * - spyOn RetrievalService.retrieve 控制阈值场景的 score
 * - 真实 docRepo（test DB）+ 真实 Document 数据
 */
import { createTestDb, TestDb } from './db-helpers';
import { startMockServer, MockServer, MockChunk } from './mock-server';
import { RagService, RagEvent } from '../src/knowledge-base/rag.service';
import { RetrievalService, RetrievalResult } from '../src/knowledge-base/retrieval.service';
import { LlmService } from '../src/llm/llm.service';
import { GlmProvider } from '../src/llm/providers/glm.provider';
import { Document, DocumentFormat, ContentSource } from '../src/documents/document.entity';
import { KnowledgeBase } from '../src/knowledge-base/entities/knowledge-base.entity';
import { randomUUID } from 'crypto';

// 收集 AsyncGenerator 产出的所有事件
async function collectEvents(gen: AsyncGenerator<RagEvent>): Promise<RagEvent[]> {
  const events: RagEvent[] = [];
  for await (const evt of gen) {
    events.push(evt);
  }
  return events;
}

describe('T6 RagService.ask 全场景集成测试', () => {
  let db: TestDb;
  let mock: MockServer;
  let ragService: RagService;
  let retrievalService: RetrievalService;
  let llmService: LlmService;
  let retrieveSpy: jest.SpyInstance;
  const userId = randomUUID();
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    db = await createTestDb();
    mock = await startMockServer();

    // 保存并设置 env，让 GlmProvider 指向 mock-server
    for (const k of ['LLM_ENABLED', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']) {
      savedEnv[k] = process.env[k];
    }
    process.env.LLM_ENABLED = 'true';
    process.env.LLM_BASE_URL = mock.url;
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_MODEL = 'mock-glm';

    // 真实 GlmProvider + LlmService（测真实 SSE 解析 + AbortSignal）
    const glmProvider = new GlmProvider();
    llmService = new LlmService([glmProvider as any]);

    // 真实 RetrievalService（spyOn retrieve 控制阈值场景）
    retrievalService = new RetrievalService(db.ds.manager, { isReady: () => false } as any);
    retrieveSpy = jest.spyOn(retrievalService, 'retrieve');

    // 真实 RagService
    ragService = new RagService(
      retrievalService,
      db.ds.getRepository(Document),
      llmService,
    );
  });

  afterEach(async () => {
    // 还原 env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    retrieveSpy.mockRestore();
    await mock.close();
    await db.close();
  });

  // 测试用工厂：构造 RetrievalResult
  function mkResult(score: number, documentId: string, content = '资料内容', hitBy: 'vector' | 'trgm' | 'both' = 'both'): RetrievalResult {
    return {
      chunkId: randomUUID(),
      content,
      documentId,
      headingPath: '章节A',
      chunkType: 'text',
      metadata: {},
      rank: 1,
      score,
      hitBy,
    };
  }

  // 测试用工厂：创建 Document + KB（供 docRepo 查标题）
  async function createDocAndKb(title: string): Promise<{ kbId: string; docId: string }> {
    const kbId = randomUUID();
    const docId = randomUUID();
    await db.ds.query(
      `INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, $2, $3)`,
      [kbId, '测试KB', userId],
    );
    const doc = db.ds.getRepository(Document).create({
      id: docId,
      categoryId: randomUUID(),
      title,
      content: '# 内容\n\n正文',
      format: DocumentFormat.MD,
      createdBy: userId,
      contentSource: ContentSource.MANUAL,
    });
    await db.ds.getRepository(Document).save(doc);
    return { kbId, docId };
  }

  // ========== 场景 1: 正常回答 ==========

  it('场景1 正常回答：reasoning + delta + references + done(isFallback=false)', async () => {
    const { kbId, docId } = await createDocAndKb('架构文档');
    // topScore=0.04 >= degradeThreshold(0.030) → 正常
    retrieveSpy.mockResolvedValue([mkResult(0.04, docId, 'RAG 架构设计内容')]);
    mock.setChatResponse([
      { type: 'reasoning', content: '分析资料...' },
      { type: 'delta', content: 'RAG 架构' },
      { type: 'delta', content: '包含检索和生成' },
      { type: 'done' },
    ]);

    const events = await collectEvents(ragService.ask(kbId, '什么是RAG架构'));

    // 事件序列：references → reasoning → delta → delta → done
    expect(events[0].type).toBe('references');
    expect(events[1].type).toBe('reasoning');
    expect(events[2].type).toBe('delta');
    expect(events[3].type).toBe('delta');
    expect(events[4].type).toBe('done');

    // references 元数据正确
    const refs = (events[0] as any).refs;
    expect(refs).toHaveLength(1);
    expect(refs[0].documentTitle).toBe('架构文档');
    expect(refs[0].refId).toBe(1);

    // done 事件 isFallback=false
    const done = events[4] as any;
    expect(done.isFallback).toBe(false);
    // answer 是所有 delta 的拼接（无降级 prefix）
    expect(done.answer).toBe('RAG 架构包含检索和生成');
  });

  // ========== 场景 2: 降级回答 ==========

  it('场景2 降级回答：prefix + delta + done(isFallback=true)', async () => {
    const { kbId, docId } = await createDocAndKb('弱相关文档');
    // topScore=0.025 < degradeThreshold(0.030) 但 >= abstainThreshold(0.020) → 降级
    retrieveSpy.mockResolvedValue([mkResult(0.025, docId, '弱相关内容')]);
    mock.setChatResponse([
      { type: 'delta', content: '部分答案' },
      { type: 'done' },
    ]);

    const events = await collectEvents(ragService.ask(kbId, '问题'));

    // references 下发
    expect(events[0].type).toBe('references');
    // 第一个 delta 是降级 prefix
    const firstDelta = events.find((e) => e.type === 'delta') as any;
    expect(firstDelta.content).toContain('相关度较低');
    // done isFallback=true
    const done = events[events.length - 1] as any;
    expect(done.type).toBe('done');
    expect(done.isFallback).toBe(true);
    // answer 含 prefix + delta
    expect(done.answer).toContain('相关度较低');
    expect(done.answer).toContain('部分答案');
  });

  // ========== 场景 3: 拒答 ==========

  it('场景3 拒答：topScore < abstainThreshold → done(isFallback=true)，不调 LLM', async () => {
    const { kbId, docId } = await createDocAndKb('不相关文档');
    // topScore=0.015 < abstainThreshold(0.020) → 拒答
    retrieveSpy.mockResolvedValue([mkResult(0.015, docId, '不相关内容')]);
    mock.setChatResponse([{ type: 'delta', content: '不该出现' }, { type: 'done' }]);

    const events = await collectEvents(ragService.ask(kbId, '问题'));

    // 只有一个 done 事件（无 references、无 delta、无 reasoning）
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
    const done = events[0] as any;
    expect(done.isFallback).toBe(true);
    expect(done.answer).toContain('未在知识库中找到');
    // mock-server 未被调用（LLM 未参与）
    expect(mock.getChatRequests()).toHaveLength(0);
  });

  it('场景3b 拒答：无检索结果 → done(isFallback=true)', async () => {
    const { kbId } = await createDocAndKb('空KB');
    retrieveSpy.mockResolvedValue([]);

    const events = await collectEvents(ragService.ask(kbId, '问题'));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
    expect((events[0] as any).isFallback).toBe(true);
    expect(mock.getChatRequests()).toHaveLength(0);
  });

  // ========== 场景 4: 中断 ==========

  it('场景4 中断：用户 abort → cancelled 事件', async () => {
    const { kbId, docId } = await createDocAndKb('文档');
    retrieveSpy.mockResolvedValue([mkResult(0.04, docId, '内容')]);
    // 模拟 LLM 流式输出（带延迟，让中断有时间触发）
    mock.setChatResponse([
      { type: 'delta', content: '第一块' },
      { type: 'delta', content: '第二块' },
      { type: 'delta', content: '第三块' },
      { type: 'done' },
    ]);
    mock.setChunkDelay(100); // 每块 100ms

    const controller = new AbortController();
    const gen = ragService.ask(kbId, '问题', controller.signal);
    const events: RagEvent[] = [];
    // 消费第一个事件（references），然后中断
    const first = await gen.next();
    if (first.value) events.push(first.value);
    // 在 LLM 输出期间 abort
    setTimeout(() => controller.abort(), 50);
    // 继续消费
    for await (const evt of gen) {
      events.push(evt);
    }

    // 应该有 cancelled 事件（或最后一个事件是 cancelled）
    expect(events.some((e) => e.type === 'cancelled')).toBe(true);
  });

  // ========== 场景 5: LLM 失败 ==========

  it('场景5 LLM 失败：GLM 返回 HTTP 500 → error 事件', async () => {
    const { kbId, docId } = await createDocAndKb('文档');
    retrieveSpy.mockResolvedValue([mkResult(0.04, docId, '内容')]);
    mock.setChatError(500, 'GLM 内部错误');

    const events = await collectEvents(ragService.ask(kbId, '问题'));

    // references 下发后，LLM 失败 → error 事件
    expect(events[0].type).toBe('references');
    const errorEvent = events.find((e) => e.type === 'error') as any;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toContain('生成失败');
  });

  // ========== 场景 6: LLM 未启用 ==========

  it('场景6 LLM 未启用：error "AI 服务未启用"', async () => {
    const { kbId, docId } = await createDocAndKb('文档');
    retrieveSpy.mockResolvedValue([mkResult(0.04, docId, '内容')]);
    // 禁用 LLM
    process.env.LLM_ENABLED = 'false';

    const events = await collectEvents(ragService.ask(kbId, '问题'));

    // references 下发后，LLM 未就绪 → error
    expect(events[0].type).toBe('references');
    const errorEvent = events.find((e) => e.type === 'error') as any;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toContain('AI 服务未启用');
    // mock-server 未被调用
    expect(mock.getChatRequests()).toHaveLength(0);
  });

  // ========== 场景 7: 空 query ==========

  it('场景7 空 query：error "问题不能为空"', async () => {
    const kbId = randomUUID();
    await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, $2, $3)`, [kbId, 'KB', userId]);

    const events = await collectEvents(ragService.ask(kbId, '   '));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect((events[0] as any).message).toBe('问题不能为空');
    expect(mock.getChatRequests()).toHaveLength(0);
  });

  // ========== 场景 8: 检索失败 ==========

  it('场景8 检索失败：retrieve 抛错 → error "检索失败"', async () => {
    const kbId = randomUUID();
    await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, $2, $3)`, [kbId, 'KB', userId]);
    retrieveSpy.mockRejectedValue(new Error('DB 连接断开'));

    const events = await collectEvents(ragService.ask(kbId, '问题'));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect((events[0] as any).message).toContain('检索失败');
  });

  // ========== 场景 9: 文档标题加载失败 ==========

  it('场景9 文档标题加载失败：docRepo 抛错 → error "加载文档信息失败"', async () => {
    const { kbId, docId } = await createDocAndKb('文档');
    retrieveSpy.mockResolvedValue([mkResult(0.04, docId, '内容')]);
    mock.setChatResponse([{ type: 'done' }]);

    // 用 spyOn 让 docRepo.find 抛错
    const docRepo = db.ds.getRepository(Document);
    const findSpy = jest.spyOn(docRepo, 'find').mockRejectedValue(new Error('DB 错误'));
    // 重建 RagService 用被 spy 的 repo
    ragService = new RagService(retrievalService, docRepo, llmService);

    const events = await collectEvents(ragService.ask(kbId, '问题'));

    expect(events[0].type).toBe('error');
    expect((events[0] as any).message).toContain('加载文档信息失败');
    findSpy.mockRestore();
  });

  // ========== 边界验证 ==========

  it('阈值边界：topScore=abstainThreshold(0.020) 不拒答（>= 阈值）', async () => {
    const { kbId, docId } = await createDocAndKb('文档');
    retrieveSpy.mockResolvedValue([mkResult(0.020, docId, '内容')]);
    mock.setChatResponse([{ type: 'delta', content: '答' }, { type: 'done' }]);

    const events = await collectEvents(ragService.ask(kbId, '问题'));
    // 不应直接拒答（有 references + delta + done）
    expect(events[0].type).toBe('references');
    const done = events[events.length - 1] as any;
    expect(done.type).toBe('done');
    // 0.020 < degradeThreshold(0.030) → 降级
    expect(done.isFallback).toBe(true);
  });

  it('阈值边界：topScore=degradeThreshold(0.030) 正常（>= 阈值）', async () => {
    const { kbId, docId } = await createDocAndKb('文档');
    retrieveSpy.mockResolvedValue([mkResult(0.030, docId, '内容')]);
    mock.setChatResponse([{ type: 'delta', content: '答' }, { type: 'done' }]);

    const events = await collectEvents(ragService.ask(kbId, '问题'));
    const done = events[events.length - 1] as any;
    expect(done.isFallback).toBe(false); // 正常
  });
});

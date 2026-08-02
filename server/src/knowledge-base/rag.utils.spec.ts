/**
 * RAG 纯函数单元测试
 *
 * 覆盖：
 * - classifyScore 三档分类（abstain/degrade/normal）+ 阈值边界
 * - buildKnowledge 格式拼接 + 截断 + 总字符上限丢弃
 * - buildPrompt system + user 结构 + prompt 注入防御文本
 */
import { classifyScore, buildKnowledge, buildPrompt } from './rag.utils';
import { RetrievalResult } from './retrieval.service';
import { RagConfig } from './rag.service';

const DEFAULT_CFG: RagConfig = {
  retrievalTopK: 8,
  abstainThreshold: 0.020,
  degradeThreshold: 0.030,
  maxChunkChars: 2000,
  maxContextChars: 8000,
  temperature: 0.3,
  maxTokens: 2048,
  llmTimeout: 120_000,
};

// 测试用工厂：构造检索结果
const mkChunk = (over: Partial<RetrievalResult>): RetrievalResult => ({
  chunkId: 'chunk-1',
  content: '默认内容',
  documentId: 'doc-1',
  headingPath: null,
  chunkType: 'text',
  metadata: {},
  rank: 1,
  score: 0.04,
  hitBy: 'both',
  ...over,
});

describe('classifyScore', () => {
  const cfg = { abstainThreshold: 0.020, degradeThreshold: 0.030 };

  it('score < abstainThreshold → abstain', () => {
    expect(classifyScore(0.019, cfg)).toBe('abstain');
    expect(classifyScore(0, cfg)).toBe('abstain');
    expect(classifyScore(0.0159, cfg)).toBe('abstain'); // bge-m3 基础相似度
  });

  it('abstainThreshold ≤ score < degradeThreshold → degrade', () => {
    expect(classifyScore(0.020, cfg)).toBe('degrade'); // 边界：等于 abstain 不拒答
    expect(classifyScore(0.025, cfg)).toBe('degrade');
    expect(classifyScore(0.0299, cfg)).toBe('degrade');
  });

  it('score ≥ degradeThreshold → normal', () => {
    expect(classifyScore(0.030, cfg)).toBe('normal'); // 边界：等于 degrade 正常
    expect(classifyScore(0.0328, cfg)).toBe('normal'); // both rank 1
    expect(classifyScore(1, cfg)).toBe('normal');
  });

  it('阈值校准值（abstain=0.020, degrade=0.030）下各场景分类正确', () => {
    // 单路 rank 1 = 1/61 ≈ 0.0164 → abstain（bge-m3 基础相似度）
    expect(classifyScore(1 / 61, cfg)).toBe('abstain');
    // both rank 1 = 2/61 ≈ 0.0328 → normal
    expect(classifyScore(2 / 61, cfg)).toBe('normal');
    // 单路 rank 1 + 单路 rank 2 = 1/61 + 1/62 ≈ 0.0325 → normal
    expect(classifyScore(1 / 61 + 1 / 62, cfg)).toBe('normal');
  });
});

describe('buildKnowledge', () => {
  const cfg = { maxChunkChars: 2000, maxContextChars: 8000 };

  it('空 chunks 返回空字符串', () => {
    expect(buildKnowledge([], new Map(), cfg)).toBe('');
  });

  it('单个 chunk 格式正确', () => {
    const chunks = [mkChunk({ content: '内容A' })];
    const titleMap = new Map([['doc-1', '标题A']]);
    const result = buildKnowledge(chunks, titleMap, cfg);
    expect(result).toBe('[资料 1] 来源：标题A | 章节：(无章节)\n内容A');
  });

  it('多 chunk 用空行分隔，编号递增', () => {
    const chunks = [
      mkChunk({ chunkId: 'c1', content: 'A', score: 0.04 }),
      mkChunk({ chunkId: 'c2', content: 'B', score: 0.03, documentId: 'doc-2' }),
    ];
    const titleMap = new Map([['doc-1', 'T1'], ['doc-2', 'T2']]);
    const result = buildKnowledge(chunks, titleMap, cfg);
    expect(result).toBe(
      '[资料 1] 来源：T1 | 章节：(无章节)\nA\n\n' +
      '[资料 2] 来源：T2 | 章节：(无章节)\nB',
    );
  });

  it('headingPath 显示', () => {
    const chunks = [mkChunk({ headingPath: 'H1/H2/H3', content: 'X' })];
    const result = buildKnowledge(chunks, new Map([['doc-1', 'T']]), cfg);
    expect(result).toContain('章节：H1/H2/H3');
  });

  it('未知文档显示 (未知文档)', () => {
    const chunks = [mkChunk({ documentId: 'no-such-doc' })];
    const result = buildKnowledge(chunks, new Map(), cfg);
    expect(result).toContain('来源：(未知文档)');
  });

  it('chunk 内容超 maxChunkChars 截断', () => {
    const long = 'X'.repeat(3000);
    const chunks = [mkChunk({ content: long })];
    const result = buildKnowledge(chunks, new Map([['doc-1', 'T']]), { maxChunkChars: 100, maxContextChars: 8000 });
    // 块头 "[资料 1] 来源：T | 章节：(无章节)\n" 长度 + 100 字符内容
    expect(result.length).toBeLessThan(long.length);
    expect(result.endsWith('X'.repeat(100))).toBe(true);
  });

  it('总字符超 maxContextChars 丢弃低分 chunk', () => {
    const chunks = [
      mkChunk({ chunkId: 'c1', content: 'A'.repeat(3000), score: 0.05 }),
      mkChunk({ chunkId: 'c2', content: 'B'.repeat(3000), score: 0.04 }),
      mkChunk({ chunkId: 'c3', content: 'C'.repeat(3000), score: 0.03 }),
    ];
    // maxChunkChars=5000 不截断 3000；maxContextChars=6500 介于 2 块（~6046）和 3 块（~9069）之间
    const result = buildKnowledge(chunks, new Map([['doc-1', 'T']]), { maxChunkChars: 5000, maxContextChars: 6500 });
    expect(result).toContain('[资料 1]');
    expect(result).toContain('[资料 2]');
    expect(result).not.toContain('[资料 3]');
    expect(result).not.toContain('C'.repeat(100));
  });
});

describe('buildPrompt', () => {
  it('返回 system + user 两条消息', () => {
    const messages = buildPrompt('问题', '资料');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('system 包含引用规范 [1][2] 指引', () => {
    const messages = buildPrompt('Q', 'K');
    expect(messages[0].content).toContain('[1][2]');
    expect(messages[0].content).toContain('引用来源');
  });

  it('system 包含 prompt 注入防御文本', () => {
    const messages = buildPrompt('Q', 'K');
    const sys = messages[0].content;
    expect(sys).toContain('参考资料');
    expect(sys).toContain('不执行');
    expect(sys).toContain('用户问题仅用于理解意图');
  });

  it('user 消息注入 knowledge + query', () => {
    const messages = buildPrompt('我的问题', '我的资料');
    expect(messages[1].content).toContain('我的资料');
    expect(messages[1].content).toContain('我的问题');
  });

  it('不同 query/knowledge 不串扰', () => {
    const m1 = buildPrompt('Q1', 'K1');
    const m2 = buildPrompt('Q2', 'K2');
    expect(m1[1].content).not.toBe(m2[1].content);
    expect(m1[0].content).toBe(m2[0].content); // system 固定
  });
});

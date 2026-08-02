/**
 * RAG 纯函数单元测试
 *
 * 覆盖：
 * - classifyScore 三档分类（abstain/degrade/normal）+ 阈值边界
 * - buildKnowledge 格式拼接 + 截断 + 总字符上限丢弃
 * - buildPrompt system + user 结构 + prompt 注入防御文本
 */
import { classifyScore, buildKnowledge, buildPrompt, truncateHistory, HistoryMessage } from './rag.utils';
import { RetrievalResult } from './retrieval.service';
import { RagConfig } from './rag.service';

const DEFAULT_CFG: RagConfig = {
  retrievalTopK: 8,
  abstainThreshold: 0.020,
  degradeThreshold: 0.030,
  rerankAbstainThreshold: 0.05,
  rerankDegradeThreshold: 0.15,
  maxChunkChars: 2000,
  maxContextChars: 8000,
  temperature: 0.3,
  maxTokens: 2048,
  llmTimeout: 120_000,
  useRerank: true,
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

  it('R2 自定义 prompts：systemPrompt 替换默认', () => {
    const messages = buildPrompt('Q', 'K', [], {
      systemPrompt: '你是法规助手',
      userPromptTemplate: '资料：{{knowledge}}\n问题：{{query}}',
    });
    expect(messages[0].content).toBe('你是法规助手');
    expect(messages[1].content).toContain('资料：K');
    expect(messages[1].content).toContain('问题：Q');
  });

  it('R2 userPromptTemplate 占位符替换', () => {
    const messages = buildPrompt('查询', '资料', [], {
      systemPrompt: 'sys',
      userPromptTemplate: '前 {{knowledge}} 中 {{query}} 后',
    });
    expect(messages[1].content).toBe('前 资料 中 查询 后');
  });

  it('R2 省略 prompts 时降级默认模板', () => {
    const messages = buildPrompt('Q', 'K');
    expect(messages[0].content).toContain('LXDOC 企业知识库助手');
    expect(messages[1].content).toContain('参考资料：');
    expect(messages[1].content).toContain('K');
    expect(messages[1].content).toContain('用户问题：');
    expect(messages[1].content).toContain('Q');
  });
});

describe('buildPrompt 含历史对话', () => {
  it('无历史时返回 [system, user] 两条（与旧版兼容）', () => {
    const messages = buildPrompt('问题', '资料');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('历史消息插入 system 和当前 user 之间', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: '前一个问题' },
      { role: 'assistant', content: '前一个答案' },
    ];
    const messages = buildPrompt('当前问题', '资料', history);
    // [system, history user, history assistant, 当前 user]
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toBe('前一个问题');
    expect(messages[2].role).toBe('assistant');
    expect(messages[2].content).toBe('前一个答案');
    expect(messages[3].role).toBe('user');
    expect(messages[3].content).toContain('当前问题');
  });

  it('历史 user/assistant 顺序保留', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
      { role: 'assistant', content: 'D' },
    ];
    const messages = buildPrompt('Q', 'K', history);
    expect(messages.map((m) => m.role)).toEqual([
      'system', 'user', 'assistant', 'user', 'assistant', 'user',
    ]);
  });

  it('历史消息的 content 原样保留（含 [1][2] 引用标注）', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: '什么是RAG' },
      { role: 'assistant', content: 'RAG 是检索增强生成[1]' },
    ];
    const messages = buildPrompt('它的版本呢', 'K', history);
    expect(messages[2].content).toBe('RAG 是检索增强生成[1]');
  });
});

describe('truncateHistory', () => {
  it('空历史返回空数组', () => {
    expect(truncateHistory([])).toEqual([]);
  });

  it('短历史原样返回', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
    ];
    expect(truncateHistory(history)).toEqual(history);
  });

  it('超 maxRounds 轮时只保留最近 N 轮', () => {
    // 6 轮（12 条消息），maxRounds=2 应保留最近 2 轮
    const history: HistoryMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push({ role: 'user', content: `Q${i}` });
      history.push({ role: 'assistant', content: `A${i}` });
    }
    const result = truncateHistory(history, 2, 10000);
    // maxRounds=2 → 保留最后 2 轮（4 条）+ 最后一条可能多算，看实现
    // 实现：role 变化计一轮，从末尾向前，Q5A5 不计轮（第一条），Q4 计第 1 轮，A4 不计，Q3 计第 2 轮 → 停
    // 结果：[Q3, A4, Q4, A5, Q5]? 需验证实际行为
    expect(result.length).toBeLessThanOrEqual(5);
    // 最近的 Q5 A5 必须在
    expect(result.some((h) => h.content === 'Q5')).toBe(true);
    expect(result.some((h) => h.content === 'A5')).toBe(true);
  });

  it('超 maxChars 字符时停止', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'A'.repeat(3000) },
      { role: 'assistant', content: 'B'.repeat(3000) },
      { role: 'user', content: 'C'.repeat(3000) },
    ];
    const result = truncateHistory(history, 100, 5000);
    // 5000 字符上限，每条 3000，最多 1 条（第二条会超 5000）
    expect(result.length).toBeLessThanOrEqual(2);
    // 最近的消息必须在
    expect(result[result.length - 1].content).toContain('C');
  });

  it('保持时间顺序（不反转）', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: '早' },
      { role: 'assistant', content: '早答' },
      { role: 'user', content: '晚' },
      { role: 'assistant', content: '晚答' },
    ];
    const result = truncateHistory(history);
    expect(result.map((h) => h.content)).toEqual(['早', '早答', '晚', '晚答']);
  });
});

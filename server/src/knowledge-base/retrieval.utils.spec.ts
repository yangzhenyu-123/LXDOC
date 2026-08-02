/**
 * rrfFuse 单元测试
 *
 * 覆盖：
 * - 两路都命中（both）：score = 1/(k+rv) + 1/(k+rt)
 * - 仅向量命中（vector）：score = 1/(k+rv)
 * - 仅词法命中（trgm）：score = 1/(k+rt)
 * - 按 score 降序
 * - k=60 标准常量下的 score 分布
 * - 空输入
 */
import { rrfFuse, VectorHit, TrgmHit } from './retrieval.utils';

// 测试用工厂：构造向量召回项
const mkVec = (chunkId: string, rank: number, content = 'c'): VectorHit => ({
  chunkId,
  content,
  documentId: 'doc-1',
  headingPath: null,
  chunkType: 'text',
  metadata: {},
  rank,
  similarity: 0.9 - rank * 0.05,
});

// 测试用工厂：构造词法召回项
const mkTrgm = (chunkId: string, rank: number, content = 'c'): TrgmHit => ({
  chunkId,
  content,
  documentId: 'doc-1',
  headingPath: null,
  chunkType: 'text',
  metadata: {},
  rank,
  similarity: 0.8 - rank * 0.05,
});

describe('rrfFuse', () => {
  const K = 60;

  it('空输入返回空数组', () => {
    expect(rrfFuse([], [], K)).toEqual([]);
  });

  it('仅向量命中：score = 1/(k+rank)，hitBy=vector', () => {
    const result = rrfFuse([mkVec('a', 1)], [], K);
    expect(result).toHaveLength(1);
    expect(result[0].chunkId).toBe('a');
    expect(result[0].hitBy).toBe('vector');
    expect(result[0].score).toBeCloseTo(1 / 61, 6);
  });

  it('仅词法命中：score = 1/(k+rank)，hitBy=trgm', () => {
    const result = rrfFuse([], [mkTrgm('b', 2)], K);
    expect(result).toHaveLength(1);
    expect(result[0].chunkId).toBe('b');
    expect(result[0].hitBy).toBe('trgm');
    expect(result[0].score).toBeCloseTo(1 / 62, 6);
  });

  it('两路都命中同一 chunk：score = 1/(k+rv) + 1/(k+rt)，hitBy=both', () => {
    const result = rrfFuse([mkVec('x', 1)], [mkTrgm('x', 1)], K);
    expect(result).toHaveLength(1);
    expect(result[0].hitBy).toBe('both');
    // both rank 1/1 = 1/61 + 1/61 = 2/61 ≈ 0.0328
    expect(result[0].score).toBeCloseTo(2 / 61, 6);
  });

  it('both 命中分数 > 单路 rank 1 分数（校验阈值排序基础）', () => {
    const both = rrfFuse([mkVec('x', 1)], [mkTrgm('x', 1)], K);
    const vecOnly = rrfFuse([mkVec('y', 1)], [], K);
    expect(both[0].score).toBeGreaterThan(vecOnly[0].score);
  });

  it('按 score 降序排列', () => {
    const vec = [mkVec('a', 1), mkVec('b', 2), mkVec('c', 3)];
    const trgm = [mkTrgm('b', 1), mkTrgm('d', 2)];
    const result = rrfFuse(vec, trgm, K);
    // b 是 both（rank 1+2）= 1/61 + 1/62 ≈ 0.0325
    // a 是 vector rank 1 = 1/61 ≈ 0.0164
    // d 是 trgm rank 2 = 1/62 ≈ 0.0161
    // c 是 vector rank 3 = 1/63 ≈ 0.0159
    expect(result.map((r) => r.chunkId)).toEqual(['b', 'a', 'd', 'c']);
    // 验证降序
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it('保留 content/documentId/headingPath/metadata', () => {
    const vec = [{ ...mkVec('a', 1), content: '向量内容', documentId: 'doc-2', headingPath: 'H1/H2', metadata: { page: 1 } }];
    const result = rrfFuse(vec, [], K);
    expect(result[0].content).toBe('向量内容');
    expect(result[0].documentId).toBe('doc-2');
    expect(result[0].headingPath).toBe('H1/H2');
    expect(result[0].metadata).toEqual({ page: 1 });
  });

  it('不同 k 值影响 score 平滑度', () => {
    // k=1 时 rank 差异放大；k=100 时 rank 差异缩小
    const small = rrfFuse([mkVec('a', 1)], [mkTrgm('a', 10)], 1);
    const large = rrfFuse([mkVec('a', 1)], [mkTrgm('a', 10)], 100);
    // k=1: 1/2 + 1/11 = 0.591
    // k=100: 1/101 + 1/110 = 0.019
    expect(small[0].score).toBeGreaterThan(large[0].score);
  });
});

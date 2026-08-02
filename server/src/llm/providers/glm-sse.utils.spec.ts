/**
 * GLM SSE 解析单元测试
 *
 * 覆盖：
 * - isDataLine：空行/注释行/非 data 行/正常 data 行
 * - parseSseLine：[DONE] / reasoning / delta / 同时 reasoning+delta / JSON 失败 / 缺 delta / 空内容
 */
import { parseSseLine, isDataLine } from './glm-sse.utils';

describe('isDataLine', () => {
  it('正常 data 行返回 true', () => {
    expect(isDataLine('data: {"choices":[]}')).toBe(true);
    expect(isDataLine('  data: {"x":1}  ')).toBe(true);
  });

  it('data: [DONE] 返回 true', () => {
    expect(isDataLine('data: [DONE]')).toBe(true);
  });

  it('空行返回 false', () => {
    expect(isDataLine('')).toBe(false);
    expect(isDataLine('   ')).toBe(false);
    expect(isDataLine('\t')).toBe(false);
  });

  it('注释行（: 开头）返回 false（SSE 心跳）', () => {
    expect(isDataLine(': keep-alive')).toBe(false);
    expect(isDataLine(':')).toBe(false);
  });

  it('非 data: 前缀行返回 false', () => {
    expect(isDataLine('event: ping')).toBe(false);
    expect(isDataLine('id: 42')).toBe(false);
    expect(isDataLine('{"x":1}')).toBe(false); // 没有 data: 前缀
  });
});

describe('parseSseLine', () => {
  it('[DONE] 返回 done 事件', () => {
    expect(parseSseLine('data: [DONE]')).toEqual([{ type: 'done' }]);
  });

  it('delta.content → delta 事件', () => {
    const line = 'data: {"choices":[{"delta":{"content":"你好"}}]}';
    expect(parseSseLine(line)).toEqual([{ type: 'delta', content: '你好' }]);
  });

  it('delta.reasoning_content → reasoning 事件', () => {
    const line = 'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}';
    expect(parseSseLine(line)).toEqual([{ type: 'reasoning', content: '思考中' }]);
  });

  it('同一 delta 同时含 reasoning + content → 两个事件', () => {
    const line = 'data: {"choices":[{"delta":{"reasoning_content":"想","content":"答"}}]}';
    expect(parseSseLine(line)).toEqual([
      { type: 'reasoning', content: '想' },
      { type: 'delta', content: '答' },
    ]);
  });

  it('delta.content 为空字符串 → 不产出（无意义增量）', () => {
    const line = 'data: {"choices":[{"delta":{"content":""}}]}';
    expect(parseSseLine(line)).toEqual([]);
  });

  it('delta.reasoning_content 为空字符串 → 不产出', () => {
    const line = 'data: {"choices":[{"delta":{"reasoning_content":""}}]}';
    expect(parseSseLine(line)).toEqual([]);
  });

  it('无 choices[0].delta → 空数组', () => {
    expect(parseSseLine('data: {"choices":[]}')).toEqual([]);
    expect(parseSseLine('data: {"choices":[{"finish_reason":"stop"}]}')).toEqual([]);
    expect(parseSseLine('data: {}')).toEqual([]);
  });

  it('JSON 解析失败 → 空数组（不抛错）', () => {
    expect(parseSseLine('data: {invalid json}')).toEqual([]);
    expect(parseSseLine('data: ')).toEqual([]);
  });

  it('非字符串 content（数字）→ 不产出（类型守护）', () => {
    const line = 'data: {"choices":[{"delta":{"content":123}}]}';
    expect(parseSseLine(line)).toEqual([]);
  });

  it('data: 后有空格也正确解析', () => {
    expect(parseSseLine('data:   [DONE]')).toEqual([{ type: 'done' }]);
    const line = 'data:   {"choices":[{"delta":{"content":"X"}}]}';
    expect(parseSseLine(line)).toEqual([{ type: 'delta', content: 'X' }]);
  });

  it('usage 字段存在不影响 delta 提取', () => {
    const line = 'data: {"choices":[{"delta":{"content":"end"}}],"usage":{"prompt_tokens":10,"completion_tokens":3}}';
    expect(parseSseLine(line)).toEqual([{ type: 'delta', content: 'end' }]);
  });
});

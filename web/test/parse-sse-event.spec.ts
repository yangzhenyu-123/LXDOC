/**
 * parseSseEvent 单元测试
 *
 * 覆盖：references / reasoning / delta / done / error / cancelled / JSON 失败 / 非 data 行 / 多行
 */
import { describe, it, expect } from 'vitest';
import { parseSseEvent } from '../src/api/kb';

describe('parseSseEvent', () => {
  it('delta 事件解析', () => {
    const evt = parseSseEvent('data: {"type":"delta","content":"你好"}');
    expect(evt).toEqual({ type: 'delta', content: '你好' });
  });

  it('reasoning 事件解析', () => {
    const evt = parseSseEvent('data: {"type":"reasoning","content":"思考中"}');
    expect(evt).toEqual({ type: 'reasoning', content: '思考中' });
  });

  it('references 事件解析（含 refs 数组）', () => {
    const raw = 'data: {"type":"references","refs":[{"refId":1,"chunkId":"c1","documentId":"d1","documentTitle":"文档A","headingPath":"H1","snippet":"片段","score":0.04,"hitBy":"both"}]}';
    const evt = parseSseEvent(raw);
    expect(evt?.type).toBe('references');
    expect((evt as any).refs).toHaveLength(1);
    expect((evt as any).refs[0].documentTitle).toBe('文档A');
  });

  it('done 事件解析（含 answer + isFallback）', () => {
    const evt = parseSseEvent('data: {"type":"done","answer":"完整答案","isFallback":false}');
    expect(evt).toEqual({ type: 'done', answer: '完整答案', isFallback: false });
  });

  it('error 事件解析', () => {
    const evt = parseSseEvent('data: {"type":"error","message":"生成失败"}');
    expect(evt).toEqual({ type: 'error', message: '生成失败' });
  });

  it('cancelled 事件解析', () => {
    const evt = parseSseEvent('data: {"type":"cancelled"}');
    expect(evt).toEqual({ type: 'cancelled' });
  });

  it('JSON 解析失败返回 null', () => {
    expect(parseSseEvent('data: {invalid}')).toBeNull();
    expect(parseSseEvent('data: ')).toBeNull();
  });

  it('无 data: 前缀返回 null', () => {
    expect(parseSseEvent('event: ping')).toBeNull();
    expect(parseSseEvent('')).toBeNull();
    expect(parseSseEvent(': comment')).toBeNull();
  });

  it('多行事件：取第一个 data: 行', () => {
    const raw = 'event: message\ndata: {"type":"delta","content":"X"}';
    const evt = parseSseEvent(raw);
    expect(evt).toEqual({ type: 'delta', content: 'X' });
  });

  it('data: 后有空格也正确解析', () => {
    const evt = parseSseEvent('data:   {"type":"delta","content":"Y"}');
    expect(evt).toEqual({ type: 'delta', content: 'Y' });
  });
});

/**
 * LlmService fallback 链单元测试（R3）
 *
 * 验证：多 Provider 注册时，主 Provider 失败自动切下一个。
 * 用 mock Provider（结构类型兼容 LlmProvider）控制 isReady / chat / streamChat 行为。
 */
import { LlmService } from './llm.service';
import {
  LlmProvider,
  LlmStreamProvider,
  LlmStreamChunk,
  LlmChatResult,
  LlmMessage,
  LlmNotSupportedException,
} from './llm-provider.interface';

/** 构造 mock Provider */
function mkProvider(opts: {
  name: string;
  ready?: boolean;
  chatResult?: LlmChatResult;
  chatError?: Error;
  streamChunks?: LlmStreamChunk[];
  streamError?: Error;
  embedUnsupported?: boolean;
}): LlmProvider {
  const ready = opts.ready ?? true;
  const provider: any = {
    name: opts.name,
    isReady: () => ready,
    chat: jest.fn(async () => {
      if (opts.chatError) throw opts.chatError;
      return opts.chatResult ?? { content: `${opts.name}-chat`, model: opts.name };
    }),
    embed: jest.fn(async () => {
      if (opts.embedUnsupported) throw new LlmNotSupportedException('no embed');
      return { embedding: [0.1], model: opts.name };
    }),
  };
  if (opts.streamChunks || opts.streamError) {
    provider.streamChat = jest.fn(async function* (): AsyncGenerator<LlmStreamChunk> {
      if (opts.streamError) throw opts.streamError;
      for (const c of opts.streamChunks ?? [{ type: 'done' }]) yield c;
    });
  }
  return provider as LlmProvider;
}

async function collectStream(gen: AsyncGenerator<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('R3 LlmService fallback 链', () => {
  it('getActiveProviders 返回所有就绪 Provider', () => {
    const p1 = mkProvider({ name: 'p1', ready: true });
    const p2 = mkProvider({ name: 'p2', ready: false });
    const p3 = mkProvider({ name: 'p3', ready: true });
    const svc = new LlmService([p1, p2, p3]);
    const active = svc.getActiveProviders();
    expect(active.length).toBe(2);
    expect(active[0].name).toBe('p1');
    expect(active[1].name).toBe('p3');
  });

  it('无就绪 Provider 时 isReady=false', () => {
    const svc = new LlmService([mkProvider({ name: 'p', ready: false })]);
    expect(svc.isReady()).toBe(false);
  });

  it('chat 主 Provider 失败切下一个', async () => {
    const p1 = mkProvider({ name: 'p1', chatError: new Error('p1 500') });
    const p2 = mkProvider({ name: 'p2', chatResult: { content: 'p2-ok', model: 'p2' } });
    const svc = new LlmService([p1, p2]);
    const result = await svc.chat([{ role: 'user', content: 'Q' }]);
    expect(result?.content).toBe('p2-ok');
    expect((p1 as any).chat).toHaveBeenCalled();
    expect((p2 as any).chat).toHaveBeenCalled();
  });

  it('chat 所有 Provider 失败返回 null', async () => {
    const p1 = mkProvider({ name: 'p1', chatError: new Error('p1 500') });
    const p2 = mkProvider({ name: 'p2', chatError: new Error('p2 500') });
    const svc = new LlmService([p1, p2]);
    const result = await svc.chat([{ role: 'user', content: 'Q' }]);
    expect(result).toBeNull();
  });

  it('chat 首个 Provider 成功不切下一个', async () => {
    const p1 = mkProvider({ name: 'p1', chatResult: { content: 'p1-ok', model: 'p1' } });
    const p2 = mkProvider({ name: 'p2' });
    const svc = new LlmService([p1, p2]);
    await svc.chat([{ role: 'user', content: 'Q' }]);
    expect((p1 as any).chat).toHaveBeenCalled();
    expect((p2 as any).chat).not.toHaveBeenCalled();
  });

  it('streamChat 主 Provider 失败切下一个', async () => {
    const p1 = mkProvider({
      name: 'p1',
      streamError: new Error('p1 stream 500'),
      streamChunks: [{ type: 'done' }],
    });
    const p2 = mkProvider({
      name: 'p2',
      streamChunks: [{ type: 'delta', content: 'p2-ok' }, { type: 'done' }],
    });
    const svc = new LlmService([p1, p2]);
    const chunks = await collectStream(svc.streamChat([{ role: 'user', content: 'Q' }]));
    expect(chunks.some((c) => c.type === 'delta' && c.content === 'p2-ok')).toBe(true);
  });

  it('streamChat 所有 Provider 失败返回 error 事件', async () => {
    const p1 = mkProvider({ name: 'p1', streamError: new Error('p1 500') });
    const p2 = mkProvider({ name: 'p2', streamError: new Error('p2 500') });
    const svc = new LlmService([p1, p2]);
    const chunks = await collectStream(svc.streamChat([{ role: 'user', content: 'Q' }]));
    expect(chunks.some((c) => c.type === 'error')).toBe(true);
  });

  it('streamChat 用户中断（AbortError）静默结束，不切下一个', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const p1 = mkProvider({ name: 'p1', streamError: abortErr });
    const p2 = mkProvider({ name: 'p2', streamChunks: [{ type: 'done' }] });
    const svc = new LlmService([p1, p2]);
    const chunks = await collectStream(svc.streamChat([{ role: 'user', content: 'Q' }]));
    // AbortError 静默结束，不 yield error 也不切 p2
    expect(chunks.length).toBe(0);
    expect((p2 as any).streamChat).not.toHaveBeenCalled();
  });

  it('embed 主 Provider 不支持时切下一个', async () => {
    const p1 = mkProvider({ name: 'p1', embedUnsupported: true });
    const p2 = mkProvider({ name: 'p2' });
    const svc = new LlmService([p1, p2]);
    const result = await svc.embed('text');
    expect(result).not.toBeNull();
    expect((p1 as any).embed).toHaveBeenCalled();
    expect((p2 as any).embed).toHaveBeenCalled();
  });

  it('embed 所有 Provider 不支持返回 null', async () => {
    const p1 = mkProvider({ name: 'p1', embedUnsupported: true });
    const p2 = mkProvider({ name: 'p2', embedUnsupported: true });
    const svc = new LlmService([p1, p2]);
    const result = await svc.embed('text');
    expect(result).toBeNull();
  });
});

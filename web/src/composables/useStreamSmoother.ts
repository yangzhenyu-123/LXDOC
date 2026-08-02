/**
 * 流式打字机平滑器（借鉴 Yuxi useStreamSmoother，简化版）
 *
 * 作用：解决 SSE 流式推送速率不稳定导致前端"卡顿→突然蹦一大段"的体验问题。
 *
 * 核心算法：
 * - EMA 自适应速率：维护 avgIntervalMs（chunk 间隔）+ avgChunkChars（chunk 大小），按指数加权平均
 * - 动态 reserve：按 lag 目标保留一定字符缓冲，避免追平后端导致抖动
 * - rAF 节流：每帧按 EMA 速率计算 emit budget，从 buffer 切片 emit
 * - overflow 保护：缓冲超 maxBufferedChars 时立即排空一部分，防内存膨胀
 * - carryChars 累积器：按帧时间分配 budget，跨帧累积余数避免丢精度
 *
 * 仅处理 content + reasoning 两个字段（LXDOC 不用 tool_call_chunks）。
 *
 * 单 controller 设计：LXDOC 一次只流式一条 assistant 消息，无需按 messageId 索引。
 * 候选 2（P9）：见 docs/rag.md P9 章节。
 */

export interface StreamSmootherOptions {
  /** 单次 emit 最小字符数，默认 1 */
  minChunkSize?: number;
  /** 单次 emit 最大字符数，默认 64（防大爆发压垮渲染） */
  maxChunkSize?: number;
  /** chunk 间隔 EMA 初始值（ms），默认 1000 */
  defaultIntervalMs?: number;
  /** drain 窗口下限（ms），avgIntervalMs 不会低于此值，默认 400 */
  minDrainWindowMs?: number;
  /** drain 窗口上限（ms），avgIntervalMs 不会超过此值，默认 1400 */
  maxDrainWindowMs?: number;
  /** 目标滞后（ms）：保持比后端慢这么多 ms，留缓冲，默认 900 */
  targetLagMs?: number;
  /** 最小保留字符数，默认 48 */
  minReserveChars?: number;
  /** 最大保留字符数，默认 240 */
  maxReserveChars?: number;
  /** 缓冲上限：超过则触发 overflow 立即排空，默认 3000 */
  maxBufferedChars?: number;
  /** EMA 平滑系数（0~1，越小越平滑），默认 0.2 */
  emaAlpha?: number;
  /** 基础节奏倍数（<1 主动比后端慢），默认 0.92 */
  basePaceMultiplier?: number;
  /** overflow 排空除数（越大排空越慢），默认 180 */
  overflowDivisor?: number;
  /** 最大爆发倍数（防瞬时飙速），默认 2.6 */
  maxBurstFactor?: number;
}

/** emit 增量回调的负载 */
export interface StreamEmitDelta {
  /** 本次 emit 的正文增量 */
  content?: string;
  /** 本次 emit 的思考链增量 */
  reasoning?: string;
}

interface SmootherController {
  contentBuffer: string;
  reasoningBuffer: string;
  scheduled: boolean;
  frameId: number | null;
  lastPushAt: number;
  lastFrameAt: number;
  carryChars: number;
  avgIntervalMs: number;
  avgChunkChars: number;
}

const DEFAULTS: Required<StreamSmootherOptions> = {
  minChunkSize: 1,
  maxChunkSize: 64,
  defaultIntervalMs: 1000,
  minDrainWindowMs: 400,
  maxDrainWindowMs: 1400,
  targetLagMs: 900,
  minReserveChars: 48,
  maxReserveChars: 240,
  maxBufferedChars: 3000,
  emaAlpha: 0.2,
  basePaceMultiplier: 0.92,
  overflowDivisor: 180,
  maxBurstFactor: 2.6,
};

/** SSR 兜底：window 不存在时用 setTimeout 退化 */
const raf =
  typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? (cb: () => void) => window.requestAnimationFrame(cb)
    : (cb: () => void) => window.setTimeout(() => cb(), 16);

const caf =
  typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
    ? (id: number) => window.cancelAnimationFrame(id)
    : (id: number) => window.clearTimeout(id);

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function createController(opts: Required<StreamSmootherOptions>): SmootherController {
  const now = Date.now();
  return {
    contentBuffer: '',
    reasoningBuffer: '',
    scheduled: false,
    frameId: null,
    lastPushAt: now,
    lastFrameAt: now,
    carryChars: 0,
    avgIntervalMs: opts.defaultIntervalMs,
    avgChunkChars: opts.minReserveChars,
  };
}

function getBufferedLength(c: SmootherController): number {
  return c.contentBuffer.length + c.reasoningBuffer.length;
}

/**
 * 计算保留字符数：基于后端速率 × 目标滞后，让前端比后端慢一点留缓冲
 */
function getReserveSize(c: SmootherController, opts: Required<StreamSmootherOptions>): number {
  const charsPerMs = c.avgChunkChars / Math.max(1, c.avgIntervalMs);
  const lagReserve = Math.ceil(charsPerMs * opts.targetLagMs);
  return clamp(Math.max(opts.minReserveChars, lagReserve), opts.minReserveChars, opts.maxReserveChars);
}

/**
 * 计算单次 emit 字符数（budget）
 */
function getChunkSize(c: SmootherController, pending: number, opts: Required<StreamSmootherOptions>): number {
  const now = Date.now();
  const deltaMs = Math.max(16, now - c.lastFrameAt);
  const charsPerMs = c.avgChunkChars / Math.max(1, c.avgIntervalMs);
  const baseRate = charsPerMs * opts.basePaceMultiplier;
  const reserve = getReserveSize(c, opts);
  const overflow = Math.max(0, pending - reserve);
  const overflowBoost = overflow / opts.overflowDivisor;
  const maxRate = Math.max(baseRate, charsPerMs * opts.maxBurstFactor);
  const pacedRate = clamp(baseRate + overflowBoost, opts.minChunkSize / 240, maxRate);

  c.carryChars += pacedRate * deltaMs;
  c.lastFrameAt = now;

  const budget = Math.floor(c.carryChars);
  if (budget <= 0) return 0;

  const maxAllowed = Math.max(1, pending - reserve);
  const emitCount = Math.min(budget, maxAllowed, opts.maxChunkSize);
  if (emitCount <= 0) return 0;

  c.carryChars -= emitCount;
  return emitCount;
}

function takeFromBuffer(value: string, count: number): { emitted: string; rest: string } {
  if (!value || count <= 0) return { emitted: '', rest: value || '' };
  return { emitted: value.slice(0, count), rest: value.slice(count) };
}

/**
 * 流式打字机平滑器（单 controller）
 *
 * 使用方式：
 * ```ts
 * const smoother = useStreamSmoother();
 * smoother.onEmit((delta) => {
 *   msg.content += delta.content ?? '';
 *   msg.reasoning += delta.reasoning ?? '';
 * });
 * // SSE delta 事件
 * smoother.pushContent(evt.content);
 * // SSE reasoning 事件
 * smoother.pushReasoning(evt.content);
 * // done/cancelled/error 时强制吐完
 * smoother.flush();
 * ```
 */
export function useStreamSmoother(options?: StreamSmootherOptions) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  let controller: SmootherController | null = null;
  let emitCallback: ((delta: StreamEmitDelta) => void) | null = null;

  function ensureController(): SmootherController {
    if (!controller) controller = createController(opts);
    return controller;
  }

  function emitDelta(forceFlush: boolean, immediateBudget: number | null = null) {
    if (!controller) return;
    const pending = getBufferedLength(controller);
    if (pending <= 0) {
      controller.scheduled = false;
      controller.frameId = null;
      return;
    }

    const hasImmediateBudget =
      immediateBudget !== null && Number.isFinite(immediateBudget) && Math.floor(immediateBudget) > 0;
    const budget = forceFlush
      ? pending
      : hasImmediateBudget && immediateBudget !== null
        ? Math.min(pending, Math.floor(immediateBudget))
        : getChunkSize(controller, pending, opts);

    let remaining = budget;
    const delta: StreamEmitDelta = {};

    // 优先 content，再 reasoning（保持正文优先显示）
    const contentPart = takeFromBuffer(controller.contentBuffer, remaining);
    if (contentPart.emitted) {
      delta.content = contentPart.emitted;
      controller.contentBuffer = contentPart.rest;
      remaining -= contentPart.emitted.length;
    }

    if (remaining > 0) {
      const reasoningPart = takeFromBuffer(controller.reasoningBuffer, remaining);
      if (reasoningPart.emitted) {
        delta.reasoning = reasoningPart.emitted;
        controller.reasoningBuffer = reasoningPart.rest;
        remaining -= reasoningPart.emitted.length;
      }
    }

    if ((delta.content || delta.reasoning) && emitCallback) {
      emitCallback(delta);
    }

    const remainingPending = getBufferedLength(controller);
    if (remainingPending > 0 && !forceFlush) {
      controller.scheduled = true;
      controller.frameId = raf(() => emitDelta(false));
      return;
    }
    controller.scheduled = false;
    controller.frameId = null;
  }

  function schedule() {
    if (!controller || controller.scheduled) return;
    controller.scheduled = true;
    controller.frameId = raf(() => emitDelta(false));
  }

  /**
   * 累积正文增量到缓冲，rAF 节流后通过 onEmit 回调吐出
   * @param delta SSE delta 事件的 content
   */
  function pushContent(delta: string): void {
    if (!delta) return;
    const c = ensureController();
    const now = Date.now();

    const observedInterval = now - c.lastPushAt;
    if (observedInterval > 0) {
      c.avgIntervalMs = clamp(
        c.avgIntervalMs * (1 - opts.emaAlpha) + observedInterval * opts.emaAlpha,
        opts.minDrainWindowMs,
        opts.maxDrainWindowMs,
      );
    }
    const incomingSize = Math.max(1, delta.length);
    c.avgChunkChars = clamp(
      c.avgChunkChars * (1 - opts.emaAlpha) + incomingSize * opts.emaAlpha,
      opts.minReserveChars,
      opts.maxReserveChars * 4,
    );

    c.lastPushAt = now;
    c.contentBuffer += delta;

    // overflow 检查：缓冲超限立即排空一部分
    const overflowBudget = Math.max(0, getBufferedLength(c) - opts.maxBufferedChars);
    if (overflowBudget > 0) {
      if (c.frameId !== null) caf(c.frameId);
      c.scheduled = false;
      c.frameId = null;
      emitDelta(false, overflowBudget);
      return;
    }
    schedule();
  }

  /**
   * 累积思考链增量到缓冲
   * @param delta SSE reasoning 事件的 content
   */
  function pushReasoning(delta: string): void {
    if (!delta) return;
    const c = ensureController();
    c.reasoningBuffer += delta;
    schedule();
  }

  /**
   * 强制吐完所有缓冲（done/cancelled/error 时调用）
   */
  function flush(): void {
    if (!controller) return;
    if (controller.frameId !== null) caf(controller.frameId);
    emitDelta(true);
  }

  /**
   * 重置 smoother（清空缓冲 + 取消 rAF），下次 send 前调用
   */
  function reset(): void {
    if (controller?.frameId !== null && controller?.frameId !== undefined) {
      caf(controller.frameId);
    }
    controller = null;
  }

  /** 是否还有未 emit 的缓冲 */
  function isBuffered(): boolean {
    return !!controller && getBufferedLength(controller) > 0;
  }

  /**
   * 注册 emit 回调，rAF 节流后增量调用
   */
  function onEmit(cb: (delta: StreamEmitDelta) => void): void {
    emitCallback = cb;
  }

  return { pushContent, pushReasoning, flush, reset, onEmit, isBuffered };
}

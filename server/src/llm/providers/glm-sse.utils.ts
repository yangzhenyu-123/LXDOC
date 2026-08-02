/**
 * SSE 解析纯函数（无 IO，可独立测试）
 *
 * 从 GlmProvider.streamChat 提取的纯逻辑：
 * - parseSseLine：解析单行 SSE data，提取 reasoning/delta/done
 *
 * 提取目的：让 SSE 解析逻辑可被单元测试直接覆盖，无需 mock fetch/ReadableStream。
 * 行为与原 GlmProvider.streamChat 内联解析完全一致。
 */
import type { LlmStreamChunk } from '../llm-provider.interface';

/**
 * 解析 SSE data 行，提取 chunk 事件
 *
 * 行格式：`data: {json}` 或 `data: [DONE]`
 * - 前缀 `data:` 去除并 trim
 * - `[DONE]` → done 事件
 * - JSON 解析失败 → null（不阻塞流）
 * - JSON 缺 choices[0].delta → null
 * - delta.reasoning_content（非空字符串）→ reasoning 事件
 * - delta.content（非空字符串）→ delta 事件
 * - 同一 delta 可同时产出 reasoning + delta（返回数组）
 *
 * 注意：本函数不处理空行、注释行（:开头）、非 data: 前缀行——由调用方预过滤。
 * 本函数只处理已 trim 且以 "data:" 开头的行。
 *
 * @param line 已 trim 的 SSE 行（必须以 "data:" 开头）
 * @returns 0-2 个 chunk 事件（reasoning/delta/done），解析失败或无内容返回 []
 */
export function parseSseLine(line: string): LlmStreamChunk[] {
  // 提取 data: 后的内容
  const data = line.slice(5).trim();
  if (data === '[DONE]') {
    return [{ type: 'done' }];
  }
  try {
    const chunk: any = JSON.parse(data);
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return [];
    const out: LlmStreamChunk[] = [];
    // 思考链增量（GLM-5.2 reasoning_content）
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      out.push({ type: 'reasoning', content: delta.reasoning_content });
    }
    // 正文增量
    if (typeof delta.content === 'string' && delta.content) {
      out.push({ type: 'delta', content: delta.content });
    }
    return out;
  } catch {
    // JSON 解析失败不阻塞流
    return [];
  }
}

/**
 * 判断 SSE 行是否应被处理（非空、非注释、以 data: 开头）
 *
 * @param rawLine 原始行（未 trim）
 * @returns true 表示应交给 parseSseLine 处理
 */
export function isDataLine(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(':')) return false; // 注释行/心跳
  if (!trimmed.startsWith('data:')) return false;
  return true;
}

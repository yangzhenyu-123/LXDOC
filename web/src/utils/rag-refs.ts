/**
 * RAG 引用标注纯函数（前端，无 IO，可独立测试）
 *
 * 从 KbAskView.renderAnswer 提取的引用替换逻辑：
 * - extractRefTokens：把 [1] [1,2] [1][2] 替换为占位符，收集 tokens
 * - buildRefTags：把 token（如 "[1,2]"）转为 pill 标签
 *
 * P9 候选 1：buildRefTags 渲染为 pill（带文档图标 + 名称 + 序号），
 * 替代原来的纯上标 [1]。refs 可选，无 refs 时回退上标（向后兼容）。
 */

import type { RagReference } from '@/api/kb';

/** 占位符前缀（避免被 marked 解析） */
const REF_PLACEHOLDER = (n: number) => `@@REF_${n}@@`;

/** 引用标注正则：匹配 [1] [1,2] [1][2] [1, 2] 等数字引用，组1捕获整个 [N] */
export const REF_PATTERN = /(\[\d+(?:[,\s\d]*)\])/g;

/**
 * 提取引用 tokens 并替换为占位符
 *
 * 把 md 中的 [1] [1,2] [1][2] 替换为 @@REF_0@@ @@REF_1@@，
 * 收集原始 token（如 "[1,2]"），供 marked 渲染后回填 pill。
 *
 * @param md 原始 markdown 文本
 * @returns { preprocessed, tokens } 替换后文本 + token 列表
 */
export function extractRefTokens(md: string): {
  preprocessed: string;
  tokens: string[];
} {
  const tokens: string[] = [];
  const preprocessed = md.replace(REF_PATTERN, (_m, p1: string) => {
    tokens.push(p1);
    return REF_PLACEHOLDER(tokens.length - 1);
  });
  return { preprocessed, tokens };
}

/**
 * 把占位符替换回引用 pill（sanitize 后注入，绕过 DOMPurify 限制）
 *
 * @param html marked 渲染 + sanitize 后的 HTML
 * @param tokens extractRefTokens 收集的 token 列表
 * @param msgIdx 消息序号（data-msg 属性，用于点击定位）
 * @param refs 引用元数据数组（可选，P9 候选 1 用于渲染 pill 文档名）
 * @returns 替换后的 HTML（含 pill span）
 */
export function replaceRefPlaceholders(
  html: string,
  tokens: string[],
  msgIdx: number,
  refs?: RagReference[],
): string {
  return html.replace(/@@REF_(\d+)@@/g, (_, i: string) => {
    const token = tokens[Number(i)];
    if (!token) return '';
    return buildRefTags(token, msgIdx, refs);
  });
}

/** 转义 HTML 特殊字符（pill 文档名展示用） */
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 截断长文档名（pill 宽度有限） */
function truncateTitle(s: string, max = 18): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * 把单个 token（如 "[1,2]"）转为 pill 标签
 *
 * P9 候选 1：有 refs 时渲染为带文档图标 + 文档名 + 序号的胶囊；
 * 无 refs 时回退为原来的纯上标 `<sup>[1]</sup>`（向后兼容旧测试）。
 *
 * @param token 引用 token，如 "[1]" "[1,2]"
 * @param msgIdx 消息序号
 * @param refs 引用元数据数组（可选）
 * @returns pill HTML（多个数字用多个 pill）
 */
export function buildRefTags(token: string, msgIdx: number, refs?: RagReference[]): string {
  // 提取数字列表：[1,2] → ['1','2']，[1] → ['1']
  const nums = token.replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
  return nums
    .map((n) => {
      const refId = Number(n);
      const ref = refs?.find((r) => r.refId === refId);
      // 无 ref 元数据时回退原上标
      if (!ref) {
        return `<sup class="rag-ref-tag" data-ref="${n}" data-msg="${msgIdx}">[${n}]</sup>`;
      }
      // P9 候选 1：pill 渲染（带文档名 + chunk id 供悬浮卡拉取）
      const docTitle = escapeHtml(truncateTitle(ref.documentTitle || `引用${n}`));
      const chunkId = escapeHtml(ref.chunkId);
      return `<span class="rag-ref-pill" data-ref="${n}" data-msg="${msgIdx}" data-chunk-id="${chunkId}" data-doc-title="${docTitle}" role="button" tabindex="0"><span class="pill-icon" aria-hidden="true">📄</span><span class="pill-text">${docTitle}</span><sup class="pill-num">[${n}]</sup></span>`;
    })
    .join('');
}

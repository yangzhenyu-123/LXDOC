/**
 * RAG 引用标注纯函数（前端，无 IO，可独立测试）
 *
 * 从 KbAskView.renderAnswer 提取的引用替换逻辑：
 * - extractRefTokens：把 [1] [1,2] [1][2] 替换为占位符，收集 tokens
 * - buildRefTags：把 token（如 "[1,2]"）转为可点击的 <sup> 上标链接
 *
 * 提取目的：让引用替换逻辑可被单元测试直接覆盖，无需挂载 Vue 组件或调用 marked。
 * 行为与原 renderAnswer 内联逻辑完全一致。
 */

/** 占位符前缀（避免被 marked 解析） */
const REF_PLACEHOLDER = (n: number) => `@@REF_${n}@@`;

/** 引用标注正则：匹配 [1] [1,2] [1][2] [1, 2] 等数字引用，组1捕获整个 [N] */
export const REF_PATTERN = /(\[\d+(?:[,\s\d]*)\])/g;

/**
 * 提取引用 tokens 并替换为占位符
 *
 * 把 md 中的 [1] [1,2] [1][2] 替换为 @@REF_0@@ @@REF_1@@，
 * 收集原始 token（如 "[1,2]"），供 marked 渲染后回填上标链接。
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
 * 把占位符替换回引用上标链接
 *
 * @param html marked 渲染 + sanitize 后的 HTML
 * @param tokens extractRefTokens 收集的 token 列表
 * @param msgIdx 消息序号（data-msg 属性，用于点击定位）
 * @returns 替换后的 HTML（含 <sup class="rag-ref-tag"> 链接）
 */
export function replaceRefPlaceholders(
  html: string,
  tokens: string[],
  msgIdx: number,
): string {
  return html.replace(/@@REF_(\d+)@@/g, (_, i: string) => {
    const token = tokens[Number(i)];
    if (!token) return '';
    return buildRefTags(token, msgIdx);
  });
}

/**
 * 把单个 token（如 "[1,2]"）转为 <sup> 上标链接
 *
 * @param token 引用 token，如 "[1]" "[1,2]" "[1, 2]"
 * @param msgIdx 消息序号
 * @returns 上标链接 HTML（多个数字用多个 <sup>）
 */
export function buildRefTags(token: string, msgIdx: number): string {
  // 提取数字列表：[1,2] → ['1','2']，[1] → ['1']
  const nums = token.replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
  return nums
    .map((n) => `<sup class="rag-ref-tag" data-ref="${n}" data-msg="${msgIdx}">[${n}]</sup>`)
    .join('');
}

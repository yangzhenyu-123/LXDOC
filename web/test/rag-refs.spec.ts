/**
 * RAG 引用标注纯函数测试
 *
 * 覆盖：
 * - extractRefTokens：[1] [1,2] [1][2] 提取 + 占位符替换
 * - buildRefTags：token → <sup> 上标链接
 * - replaceRefPlaceholders：占位符回填
 */
import { describe, it, expect } from 'vitest';
import {
  extractRefTokens,
  buildRefTags,
  replaceRefPlaceholders,
  REF_PATTERN,
} from '../src/utils/rag-refs';

describe('REF_PATTERN', () => {
  it('匹配 [1]', () => {
    expect('[1]'.match(REF_PATTERN)).toEqual(['[1]']);
  });

  it('匹配 [1,2]', () => {
    expect('[1,2]'.match(REF_PATTERN)).toEqual(['[1,2]']);
  });

  it('匹配 [1][2]（两个独立引用）', () => {
    expect('[1][2]'.match(REF_PATTERN)).toEqual(['[1]', '[2]']);
  });

  it('不匹配非数字 [文字]', () => {
    expect('[文字]'.match(REF_PATTERN)).toBeNull();
    expect('[abc]'.match(REF_PATTERN)).toBeNull();
  });

  it('不匹配空 []', () => {
    expect('[]'.match(REF_PATTERN)).toBeNull();
  });
});

describe('extractRefTokens', () => {
  it('无引用返回原文 + 空 tokens', () => {
    const { preprocessed, tokens } = extractRefTokens('普通文本无引用');
    expect(preprocessed).toBe('普通文本无引用');
    expect(tokens).toEqual([]);
  });

  it('单个 [1] 替换为占位符', () => {
    const { preprocessed, tokens } = extractRefTokens('答案[1]');
    expect(tokens).toEqual(['[1]']);
    expect(preprocessed).toBe('答案@@REF_0@@');
  });

  it('多个引用 [1][2] 顺序占位', () => {
    const { preprocessed, tokens } = extractRefTokens('A[1]B[2]C');
    expect(tokens).toEqual(['[1]', '[2]']);
    expect(preprocessed).toBe('A@@REF_0@@B@@REF_1@@C');
  });

  it('复合引用 [1,2] 作为单 token', () => {
    const { tokens } = extractRefTokens('见[1,2]');
    expect(tokens).toEqual(['[1,2]']);
  });

  it('混合 [1] 和 [2,3]', () => {
    const { tokens } = extractRefTokens('A[1]B[2,3]C');
    expect(tokens).toEqual(['[1]', '[2,3]']);
  });

  it('不匹配非数字引用 [abc]', () => {
    const { preprocessed, tokens } = extractRefTokens('A[abc]B[1]C');
    expect(tokens).toEqual(['[1]']);
    expect(preprocessed).toBe('A[abc]B@@REF_0@@C');
  });
});

describe('buildRefTags', () => {
  it('[1] → 单个 <sup>', () => {
    const html = buildRefTags('[1]', 0);
    expect(html).toBe('<sup class="rag-ref-tag" data-ref="1" data-msg="0">[1]</sup>');
  });

  it('[1,2] → 两个 <sup>', () => {
    const html = buildRefTags('[1,2]', 1);
    expect(html).toContain('data-ref="1"');
    expect(html).toContain('data-ref="2"');
    expect(html).toContain('data-msg="1"');
    // 两个 sup 链接
    expect(html.match(/<sup/g)?.length).toBe(2);
  });

  it('[1, 2] 带空格也正确提取数字', () => {
    const html = buildRefTags('[1, 2]', 2);
    expect(html).toContain('data-ref="1"');
    expect(html).toContain('data-ref="2"');
  });

  it('msgIdx 写入 data-msg 属性', () => {
    const html = buildRefTags('[1]', 42);
    expect(html).toContain('data-msg="42"');
  });
});

describe('replaceRefPlaceholders', () => {
  it('占位符回填为 <sup> 链接', () => {
    const html = '<p>答案@@REF_0@@</p>';
    const tokens = ['[1]'];
    const result = replaceRefPlaceholders(html, tokens, 0);
    expect(result).toBe('<p>答案<sup class="rag-ref-tag" data-ref="1" data-msg="0">[1]</sup></p>');
  });

  it('多个占位符顺序回填', () => {
    const html = '<p>A@@REF_0@@B@@REF_1@@</p>';
    const tokens = ['[1]', '[2]'];
    const result = replaceRefPlaceholders(html, tokens, 1);
    expect(result).toContain('data-ref="1"');
    expect(result).toContain('data-ref="2"');
    expect(result).toContain('data-msg="1"');
  });

  it('无占位符返回原文', () => {
    const html = '<p>无引用</p>';
    const result = replaceRefPlaceholders(html, [], 0);
    expect(result).toBe('<p>无引用</p>');
  });

  it('无效占位符索引返回空字符串', () => {
    const html = '<p>@@REF_99@@</p>';
    const tokens = ['[1]']; // 只有 1 个 token
    const result = replaceRefPlaceholders(html, tokens, 0);
    expect(result).toBe('<p></p>');
  });
});

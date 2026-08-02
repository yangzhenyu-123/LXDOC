import { sanitizeText } from './chunking.service';

/**
 * 文本净化单元测试
 * 对应 TODO 2.2.3：chunking 前去除乱码字符，防止污染 embedding 向量
 */
describe('sanitizeText', () => {
  it('空字符串/null/undefined 原样返回', () => {
    expect(sanitizeText('')).toBe('');
    expect(sanitizeText(null as unknown as string)).toBeNull();
    expect(sanitizeText(undefined as unknown as string)).toBeUndefined();
  });

  it('去除 BOM', () => {
    expect(sanitizeText('\uFEFF你好')).toBe('你好');
    expect(sanitizeText('\uFEFF\uFEFF正文\uFEFF')).toBe('正文');
  });

  it('去除零宽字符', () => {
    // U+200B 零宽空格、U+200C 非连接符、U+200D 连接符、U+2060 不间断分隔符
    expect(sanitizeText('a\u200Bb\u200Cc\u200Dd\u2060e')).toBe('abcde');
    // 中文之间插入的零宽字符
    expect(sanitizeText('知\u200B识\u200C库')).toBe('知识库');
  });

  it('去除控制字符但保留 \\n（\\t 会在后续空白压缩步转为空格）', () => {
    expect(sanitizeText('a\x00b\x01c')).toBe('abc');
    expect(sanitizeText('a\x07b')).toBe('ab'); // BEL
    // 保留 \n
    expect(sanitizeText('第一行\n第二行')).toBe('第一行\n第二行');
    // \t 在控制字符过滤步保留，但后续空白压缩步会转为空格（markdown 代码块缩进语义不影响 chunking）
    expect(sanitizeText('a\tb')).toBe('a b');
  });

  it('全角空格转半角', () => {
    expect(sanitizeText('全角\u3000空格')).toBe('全角 空格');
  });

  it('CRLF 转 LF', () => {
    expect(sanitizeText('a\r\nb')).toBe('a\nb');
    expect(sanitizeText('a\rb')).toBe('a\nb');
  });

  it('连续空白压缩为单个空格', () => {
    expect(sanitizeText('a    b')).toBe('a b');
    // \t 属空白，与空格一起压缩为单个空格（markdown 代码块缩进语义不影响 chunking）
    expect(sanitizeText('a\t\tb')).toBe('a b');
    expect(sanitizeText('a \t b')).toBe('a b');
    // 换行不压缩，连续空行保留（chunking 按段落切分依赖空行结构）
    expect(sanitizeText('a b\n\n\nc')).toBe('a b\n\n\nc');
  });

  it('行尾空白去除', () => {
    expect(sanitizeText('行一   \n行二  ')).toBe('行一\n行二');
  });

  it('整体首尾 trim', () => {
    expect(sanitizeText('  正文  ')).toBe('正文');
  });

  it('保留合法 Unicode（CJK + emoji）', () => {
    expect(sanitizeText('中文测试🎉emoji')).toBe('中文测试🎉emoji');
    expect(sanitizeText('混合 English 中文 123')).toBe('混合 English 中文 123');
  });

  it('PDF 抽取典型乱码场景', () => {
    // PDF 抽取常混入 BOM + 零宽字符 + 控制字符 + 全角空格
    const dirty = '\uFEFF\u200B第一段\x00。\u3000\u200B第二段\x01。';
    expect(sanitizeText(dirty)).toBe('第一段。 第二段。');
  });

  it('不误伤 markdown 结构', () => {
    const md = '# 标题\n\n## 二级标题\n\n正文段落\n\n```js\ncode\n```';
    expect(sanitizeText(md)).toBe('# 标题\n\n## 二级标题\n\n正文段落\n\n```js\ncode\n```');
  });

  it('不误伤表格', () => {
    const table = '| 列1 | 列2 |\n|---|---|\n| a | b |';
    expect(sanitizeText(table)).toBe('| 列1 | 列2 |\n|---|---|\n| a | b |');
  });
});

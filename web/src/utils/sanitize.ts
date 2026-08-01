import DOMPurify from 'dompurify';

/**
 * 净化 HTML，防止存储型 XSS。
 * 用于渲染用户可控内容（Markdown 渲染结果、搜索 snippet、PDF/docx 预览 HTML）前的兜底过滤。
 *
 * 策略：保留常见富文本标签与属性，禁用 script/事件处理器/javascript: 协议。
 */
export function sanitizeHtml(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    // 允许常见展示性标签；marked/pandoc/pdf2htmlEX 输出基本在此范围内
    ALLOWED_TAGS: [
      'a', 'b', 'i', 'em', 'strong', 'u', 's', 'del', 'mark', 'small', 'sub', 'sup',
      'p', 'br', 'hr', 'span', 'div', 'blockquote', 'pre', 'code',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
      'img', 'figure', 'figcaption',
      'details', 'summary',
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan',
      'class', 'id', 'target', 'rel',
      'style', // pdf2htmlEX/pandoc 依赖 style 做版式定位；DOMPurify 会过滤 expression/javascript:
    ],
    // 允许协议：http(s)/mailto/data(图片)/相对路径(同源)，禁止 javascript:
    // 相对路径（/api/files/...）用于后端鉴权图片/PDF URL，需显式放行
    ALLOWED_URI_REGEXP: /^(?:(?:https?:|mailto:)?\/\/|\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i,
  });
}

/**
 * 净化 marked 渲染输出。
 * marked v18 已移除内置 sanitize，须在渲染后调用本函数。
 */
export function sanitizeMarkedHtml(html: string): string {
  return sanitizeHtml(html);
}

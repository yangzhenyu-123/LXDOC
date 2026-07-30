import { DocumentFormat } from '../../documents/document.entity';

/**
 * 文件解析器接口
 * 每种格式（md/txt/docx/odt/pdf）实现一个 parser
 * parse 返回解析后的正文 content 与可选 title
 */
export interface FileParser {
  parse(
    filePath: string,
    docId: string,
    format: DocumentFormat,
  ): Promise<{ content: string | null; title?: string; pages?: number }>;
}

/**
 * 文件解析器 DI token，用于多 provider 注入
 */
export const FILE_PARSERS = Symbol('FILE_PARSERS');

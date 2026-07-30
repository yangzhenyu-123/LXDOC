import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { DocumentFormat } from '../../documents/document.entity';
import { FileParser } from './parser.interface';

/**
 * PDF 解析器
 * 使用 pdf-parse 提取全文，title 取前 100 字符（去空白换行）
 * PDF 正文不入库（content=null），仅用于索引/标题
 */
@Injectable()
export class PdfParser implements FileParser {
  private readonly logger = new Logger(PdfParser.name);

  async parse(
    filePath: string,
    _docId: string,
    _format: DocumentFormat,
  ): Promise<{ content: string | null; title?: string; pages?: number }> {
    // 动态引入以避免在依赖未安装时影响其他模块的运行
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = (await import('pdf-parse')).default;
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);

    this.logger.log(`PDF 解析完成，页数 ${data.numpages}`);

    // 标题取前 100 字符，去除多余空白与换行
    const normalized = (data.text || '')
      .replace(/\s+/g, ' ')
      .trim();
    const title = normalized.slice(0, 100) || '未命名 PDF';

    // PDF 正文不入库，但返回页数供元信息持久化
    return { content: null, title, pages: data.numpages };
  }
}

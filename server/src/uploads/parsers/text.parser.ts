import { Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { DocumentFormat } from '../../documents/document.entity';
import { FileParser } from './parser.interface';

/**
 * 纯文本解析器
 * 处理 markdown / txt，直接以 utf-8 读取文件内容
 * 标题由 service 用文件名设置，此处不返回 title
 */
@Injectable()
export class TextParser implements FileParser {
  async parse(
    filePath: string,
    _docId: string,
    _format: DocumentFormat,
  ): Promise<{ content: string | null; title?: string }> {
    const text = await fs.readFile(filePath, 'utf-8');
    return { content: text };
  }
}

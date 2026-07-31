import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DocumentFormat } from '../../documents/document.entity';
import { FileParser } from './parser.interface';
import { getUploadDir } from '../../config/upload.config';
import { doclingConfig } from '../../config/docling.config';

// 支持的图片 MIME → 扩展名（与 upload.config.allowedImageMimes 对齐）
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// 匹配 markdown 中的 data URI 图片：![alt](data:image/png;base64,xxxx)
const DATA_URI_IMG_RE =
  /!\[([^\]]*)\]\(data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)\)/g;

/**
 * Docling 解析器（主解析器）
 *
 * 调用 docling-serve HTTP API（POST /v1/convert/file）将文档统一转为 Markdown，
 * 并提取内嵌图片（image_export_mode=embedded，data URI）落盘到 images/<docId>/，
 * 改写图片链接为 /api/files/<docId>/image/<name>（存库不含 token，前端渲染时拼 ?token=）。
 *
 * 优势：统一处理 docx/odt/pdf，支持 PDF 图片/表格/版式/OCR（扫描件）。
 * 失败时由 uploads.service 回退到 pandoc / pdf-parse，保证可用性。
 *
 * 使用 Node 20 原生 fetch + FormData，零额外依赖。
 */
@Injectable()
export class DoclingParser implements FileParser {
  private readonly logger = new Logger(DoclingParser.name);

  async parse(
    filePath: string,
    docId: string,
    _format: DocumentFormat,
  ): Promise<{ content: string | null; title?: string }> {
    const uploadDir = getUploadDir();
    const imagesDir = path.join(uploadDir, 'images', docId);
    await fs.mkdir(imagesDir, { recursive: true });

    const fileBuffer = await fs.readFile(filePath);
    const filename = path.basename(filePath);

    // 构造 multipart：file + 转换参数
    // image_export_mode=embedded：图片以 data URI 内嵌进 markdown，HTTP 一次性返回，
    // 不依赖 docling 服务端文件系统，后端解码落盘即可
    const blob = new Blob([new Uint8Array(fileBuffer)]);
    const form = new FormData();
    form.append('files', blob, filename);
    form.append('image_export_mode', 'embedded');
    form.append('to_formats', 'md');
    if (doclingConfig.doOcr) {
      form.append('do_ocr', 'true');
    }

    const headers: Record<string, string> = {};
    if (doclingConfig.apiKey) {
      headers['X-Api-Key'] = doclingConfig.apiKey;
    }

    let resp: Response;
    try {
      resp = await fetch(`${doclingConfig.baseUrl}/v1/convert/file`, {
        method: 'POST',
        body: form,
        headers,
        signal: AbortSignal.timeout(doclingConfig.timeout),
      });
    } catch (err) {
      throw new InternalServerErrorException(
        `docling 服务调用失败：${(err as Error).message}`,
      );
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new InternalServerErrorException(
        `docling 转换失败（HTTP ${resp.status}）：${detail.slice(0, 500)}`,
      );
    }

    // 响应可能是 JSON（含 document.md_content）或纯文本 markdown，健壮解析
    const respText = await resp.text();
    let md = '';
    try {
      const data = JSON.parse(respText);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const m =
          item?.document?.md_content ?? item?.md_content ?? item?.markdown;
        if (typeof m === 'string' && m) {
          md = m;
          break;
        }
      }
      if (!md && typeof data === 'string') {
        md = data;
      }
    } catch {
      // 非 JSON，按纯文本 markdown 处理
      md = respText;
    }

    if (!md.trim()) {
      throw new InternalServerErrorException('docling 返回内容为空');
    }

    // 提取 data URI 图片：先收集 + 同步替换 markdown 占位，再 await 落盘
    // 图片名稳定化：image_0001.png / image_0002.jpg ... 便于重解析幂等
    let imgIndex = 0;
    const pending: { name: string; buf: Buffer }[] = [];
    md = md.replace(DATA_URI_IMG_RE, (_match, alt: string, subtype: string, b64: string) => {
      imgIndex++;
      const ext = MIME_TO_EXT[`image/${subtype}`] ?? 'png';
      const name = `image_${String(imgIndex).padStart(4, '0')}.${ext}`;
      pending.push({ name, buf: Buffer.from(b64, 'base64') });
      return `![${alt}](/api/files/${docId}/image/${name})`;
    });

    if (pending.length > 0) {
      await Promise.all(
        pending.map((p) =>
          fs
            .writeFile(path.join(imagesDir, p.name), p.buf)
            .catch((e) =>
              this.logger.warn(`图片落盘失败 ${p.name}：${(e as Error).message}`),
            ),
        ),
      );
      this.logger.log(`docling 提取图片 ${pending.length} 张到 images/${docId}/`);
    }

    return { content: md };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getUploadDir } from '../config/upload.config';

/**
 * PDF 工具服务
 * 封装两类外部二进制（系统安装，Dockerfile 中配置）：
 * - pdf2htmlEX：PDF → 保留版式的 HTML（版式保真预览）
 * - soffice（LibreOffice headless）：PDF → docx，配合 pandoc 转 markdown（转可编辑）
 *
 * 二进制未安装时抛带提示的错误，调用方据此降级（前端提示工具不可用）。
 * 产出缓存到 uploads/cache/<docId>/ 下，按 docId+version 复用。
 */
@Injectable()
export class PdfToolsService {
  private readonly logger = new Logger(PdfToolsService.name);

  // 二进制路径，可通过 env 覆盖
  private readonly pdf2htmlBin = process.env.PDF2HTML_BIN ?? 'pdf2htmlEX';
  private readonly sofficeBin = process.env.SOFTWARE_BIN ?? process.env.SOFFICE_BIN ?? 'soffice';

  /**
   * 生成 PDF 的版式保真 HTML（带缓存）
   * 命中缓存直接返回；否则调用 pdf2htmlEX 生成并缓存。
   * @param pdfAbsPath PDF 原文件绝对路径
   * @param docId 文档 id
   * @param version 文档版本（版本变化时重新生成）
   * @returns HTML 字符串
   */
  async generateLayoutHtml(
    pdfAbsPath: string,
    docId: string,
    version: number,
  ): Promise<string> {
    const cacheFile = this.cachePath(docId, `pdf-v${version}.html`);
    if (existsSync(cacheFile)) {
      return fs.readFile(cacheFile, 'utf-8');
    }
    if (!existsSync(pdfAbsPath)) {
      throw new Error(`PDF 原文件不存在：${pdfAbsPath}`);
    }
    // pdf2htmlEX 输出到临时目录后读回（避免与缓存文件名耦合）
    const outDir = this.cacheDir(docId);
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, `pdf-v${version}.html`);
    // --zoom 1.3 提升清晰度；--embed cfhj 嵌入 css/font/image 避免散文件
    await this.runBinary(
      this.pdf2htmlBin,
      ['--zoom', '1.3', '--embed', 'cfhj', pdfAbsPath, outFile],
      'pdf2htmlEX',
    );
    const html = await fs.readFile(outFile, 'utf-8');
    // 写入缓存（已是同一文件，这里仅确保存在）
    return html;
  }

  /**
   * PDF → docx（LibreOffice headless）→ markdown（pandoc）
   * 返回 markdown 文本，供转可编辑文档使用。
   * @param pdfAbsPath PDF 原文件绝对路径
   * @param docId 文档 id（用于临时工作目录隔离）
   */
  async convertPdfToMarkdown(
    pdfAbsPath: string,
    docId: string,
  ): Promise<string> {
    if (!existsSync(pdfAbsPath)) {
      throw new Error(`PDF 原文件不存在：${pdfAbsPath}`);
    }
    const workDir = path.join(getUploadDir(), 'cache', docId, 'convert');
    await fs.mkdir(workDir, { recursive: true });
    // 1. soffice 转 docx
    await this.runBinary(
      this.sofficeBin,
      [
        '--headless',
        '--convert-to',
        'docx',
        '--outdir',
        workDir,
        pdfAbsPath,
      ],
      'soffice (LibreOffice)',
      120_000,
    );
    // 找到生成的 docx（文件名与原 pdf 同名，扩展名变 docx）
    const baseName = path.basename(pdfAbsPath, path.extname(pdfAbsPath));
    const docxFile = path.join(workDir, `${baseName}.docx`);
    if (!existsSync(docxFile)) {
      throw new Error('soffice 转换未产出 docx 文件');
    }
    // 2. pandoc docx → markdown
    const mdFile = path.join(workDir, `${baseName}.md`);
    await this.runBinary(
      'pandoc',
      ['-f', 'docx', '-t', 'markdown', docxFile, '-o', mdFile],
      'pandoc',
    );
    const markdown = await fs.readFile(mdFile, 'utf-8');
    // 清理临时工作目录
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    return markdown;
  }

  private cacheDir(docId: string): string {
    return path.join(getUploadDir(), 'cache', docId);
  }

  private cachePath(docId: string, filename: string): string {
    return path.join(this.cacheDir(docId), filename);
  }

  /**
   * 统一的二进制执行封装：ENOENT 提示未安装，超时与失败抛带工具名的错误
   */
  private runBinary(
    bin: string,
    args: string[],
    label: string,
    timeout = 60_000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout, maxBuffer: 50 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              this.logger.error(`${label} 未安装（${bin} 不存在）`);
              reject(new Error(`${label} 未安装，请联系管理员安装该工具`));
              return;
            }
            this.logger.error(`${label} 执行失败：${err.message}; stderr: ${stderr}`);
            reject(new Error(`${label} 转换失败：${err.message}`));
            return;
          }
          resolve();
        },
      );
    });
  }
}

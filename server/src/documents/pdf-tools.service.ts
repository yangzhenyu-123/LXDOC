import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getUploadDir } from '../config/upload.config';

/**
 * PDF 工具服务
 * 封装两类外部工具：
 * - pdf2htmlEX：PDF → 保留版式的 HTML（版式保真预览）
 *   生产部署为独立 sidecar HTTP 服务（docker/pdf2html），通过 PDF2HTML_URL 调用；
 *   本地开发可直接装 pdf2htmlEX 二进制（PDF2HTML_BIN）作为降级，无需启动 sidecar。
 * - soffice（LibreOffice headless）：PDF → docx，配合 pandoc 转 markdown（转可编辑）
 *   仍在后端镜像内本地执行（soffice/pandoc 在 stable 仓库可用）。
 *
 * 工具不可用时抛带提示的错误，调用方据此降级（前端提示工具不可用）。
 * 产出缓存到 uploads/cache/<docId>/ 下，按 docId+version 复用。
 */
@Injectable()
export class PdfToolsService {
  private readonly logger = new Logger(PdfToolsService.name);

  // pdf2htmlEX sidecar HTTP 地址（生产）；为空则走本地二进制（开发降级）
  private readonly pdf2htmlUrl = (process.env.PDF2HTML_URL ?? '').trim();
  // 本地二进制路径（仅 PDF2HTML_URL 为空时使用），可通过 env 覆盖
  private readonly pdf2htmlBin = process.env.PDF2HTML_BIN ?? 'pdf2htmlEX';
  private readonly sofficeBin = process.env.SOFFICE_BIN ?? 'soffice';

  /**
   * 按 docId 串行化 pdf2htmlEX 生成，避免并发请求同时写同一缓存文件产生竞态。
   * key=docId#version，value=进行中的生成 Promise，请求共享同一结果。
   */
  private readonly layoutLocks = new Map<string, Promise<string>>();

  /**
   * 生成 PDF 的版式保真 HTML（带缓存）
   * 命中缓存直接返回；否则调用 pdf2htmlEX 生成并缓存。
   * 并发安全：相同 docId#version 的并发请求共享同一生成 Promise（进程内锁），
   * 避免两个请求同时 pdf2htmlEX 写同一文件。
   * 原子写：先写 .tmp 文件，成功后 rename 原子替换缓存文件，防止半截损坏 HTML 被后续缓存命中。
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
    // 命中缓存直接返回
    if (existsSync(cacheFile)) {
      return fs.readFile(cacheFile, 'utf-8');
    }
    if (!existsSync(pdfAbsPath)) {
      throw new Error(`PDF 原文件不存在：${pdfAbsPath}`);
    }

    const lockKey = `${docId}#v${version}`;
    const existing = this.layoutLocks.get(lockKey);
    if (existing) {
      // 已有生成在进行中，复用其结果
      return existing;
    }

    const task = (async () => {
      const outDir = this.cacheDir(docId);
      await fs.mkdir(outDir, { recursive: true });
      // 临时输出文件，生成成功后原子 rename 为缓存文件
      const tmpOut = path.join(outDir, `pdf-v${version}.html.tmp-${Date.now()}`);
      // --zoom 1.3 提升清晰度；--embed cfhj 嵌入 css/font/image 避免散文件
      try {
        if (this.pdf2htmlUrl) {
          // 生产：HTTP 调用 pdf2htmlEX sidecar
          const html = await this.generateLayoutHtmlViaHttp(pdfAbsPath);
          await fs.writeFile(tmpOut, html, 'utf-8');
        } else {
          // 开发降级：本地二进制
          await this.runBinary(
            this.pdf2htmlBin,
            ['--zoom', '1.3', '--embed', 'cfhj', pdfAbsPath, tmpOut],
            'pdf2htmlEX',
          );
        }
        // 原子替换为缓存文件
        await fs.rename(tmpOut, cacheFile);
        return await fs.readFile(cacheFile, 'utf-8');
      } catch (err) {
        // 生成失败时清理临时文件，避免残留半截 HTML
        await fs.unlink(tmpOut).catch(() => undefined);
        throw err;
      } finally {
        this.layoutLocks.delete(lockKey);
      }
    })();

    this.layoutLocks.set(lockKey, task);
    return task;
  }

  /**
   * PDF → docx（LibreOffice headless）→ markdown（pandoc）
   * 返回 markdown 文本，供转可编辑文档使用。
   * 临时工作目录用 try/finally 确保清理，避免转换失败残留中间文件。
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
    try {
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
      return await fs.readFile(mdFile, 'utf-8');
    } finally {
      // 无论成功失败都清理临时工作目录，避免残留
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * 通过 HTTP 调用 pdf2htmlEX sidecar 生成版式 HTML
   * - 读取本地 PDF 原文件字节，POST 到 sidecar 的 /convert（原始字节，非 multipart）
   * - sidecar 返回单文件 HTML（已 --embed cfhj）
   * - 设置超时，失败抛带状态码与响应体的错误，便于调用方降级
   * 鉴权说明：sidecar 仅在 docker 内网暴露，不对外发布，故无需 token；
   * 若后续需暴露，应在 sidecar 侧增加共享 secret 校验。
   */
  private async generateLayoutHtmlViaHttp(pdfAbsPath: string): Promise<string> {
    const buffer = await fs.readFile(pdfAbsPath);
    const url = `${this.pdf2htmlUrl.replace(/\/$/, '')}/convert`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: buffer,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err: any) {
      // 网络错误 / sidecar 未启动 / 超时
      if (err?.name === 'TimeoutError') {
        throw new Error('pdf2htmlEX sidecar 转换超时');
      }
      throw new Error(
        `调用 pdf2htmlEX sidecar 失败：${err?.message ?? err}（请检查 PDF2HTML_URL 与 sidecar 是否运行）`,
      );
    }
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 500);
      throw new Error(
        `pdf2htmlEX sidecar 返回 HTTP ${resp.status}：${detail}`,
      );
    }
    return await resp.text();
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

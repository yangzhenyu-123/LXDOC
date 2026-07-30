import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DocumentFormat } from '../../documents/document.entity';
import { FileParser } from './parser.interface';
import { getUploadDir } from '../../config/upload.config';

/**
 * Pandoc 解析器
 * 处理 docx / odt：调用 pandoc 转 markdown 并抽取图片到 images 目录
 * 随后改写 markdown 中的图片链接为 /api/files/<docId>/image/xxx
 * （存库内容不含 token，渲染时由前端拼 ?token=<fileToken>）
 */
@Injectable()
export class PandocParser implements FileParser {
  private readonly logger = new Logger(PandocParser.name);

  async parse(
    filePath: string,
    docId: string,
    format: DocumentFormat,
  ): Promise<{ content: string | null; title?: string }> {
    const uploadDir = getUploadDir();
    // pandoc --extract-media 会在此目录下生成 media/ 子目录
    const imagesDir = path.join(uploadDir, 'images', docId);
    const tmpOutputMd = path.join(imagesDir, 'output.md');

    await fs.mkdir(imagesDir, { recursive: true });

    try {
      // 调用 pandoc：抽取媒体到 imagesDir/media/，输出 markdown 到 tmpOutputMd
      await this.runPandoc([
        `--extract-media=${imagesDir}`,
        '-f',
        format === DocumentFormat.DOCX ? 'docx' : 'odt',
        '-t',
        'markdown',
        filePath,
        '-o',
        tmpOutputMd,
      ]);

      let content = await fs.readFile(tmpOutputMd, 'utf-8');

      // 把 imagesDir/media/ 下的图片搬到 imagesDir 根目录
      const mediaDir = path.join(imagesDir, 'media');
      if (existsSync(mediaDir)) {
        const files = await fs.readdir(mediaDir);
        for (const f of files) {
          const from = path.join(mediaDir, f);
          const to = path.join(imagesDir, f);
          // 若同名已存在则覆盖
          await fs.rename(from, to).catch(async () => {
            await fs.copyFile(from, to);
            await fs.unlink(from).catch(() => undefined);
          });
        }
        // 删除空的 media/ 子目录
        await fs.rmdir(mediaDir).catch(() => undefined);
      }

      // 改写 markdown 中的图片链接：
      // ![..](./media/xxx) 或 ![..](media/xxx) → ![..](/api/files/<docId>/image/xxx)
      content = content.replace(
        /!\[([^\]]*)\]\(\.?\/?media\/([^)]+)\)/g,
        (_match, alt: string, name: string) =>
          `![${alt}](/api/files/${docId}/image/${name})`,
      );

      return { content };
    } catch (err) {
      // 已是 Nest 异常则原样抛出
      if (
        err instanceof InternalServerErrorException ||
        (err as Error)?.name === 'InternalServerErrorException'
      ) {
        throw err;
      }
      throw new InternalServerErrorException(
        `Pandoc 解析失败：${(err as Error).message}`,
      );
    } finally {
      // 清理临时 markdown 输出文件
      await fs.unlink(tmpOutputMd).catch(() => undefined);
    }
  }

  /**
   * 包装 execFile 为 Promise，超时 60s
   * pandoc 未安装时抛 InternalServerErrorException('Pandoc 未安装')
   */
  private runPandoc(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        'pandoc',
        args,
        { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            // pandoc 命令不存在时 err.code === 'ENOENT'
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              this.logger.error('pandoc 未安装');
              reject(new InternalServerErrorException('Pandoc 未安装'));
              return;
            }
            this.logger.error(`pandoc stderr: ${stderr}`);
            reject(
              new InternalServerErrorException(
                `Pandoc 转换失败：${err.message}`,
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }
}

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Document, DocumentFormat, DocumentOwnerType, ContentSource } from '../documents/document.entity';
import { DocumentVersion } from '../documents/document-version.entity';
import { Category } from '../categories/category.entity';
import { TextParser } from './parsers/text.parser';
import { PandocParser } from './parsers/pandoc.parser';
import { PdfParser } from './parsers/pdf.parser';
import { getUploadDir, uploadConfig } from '../config/upload.config';

// 扩展名 → DocumentFormat 映射
const EXT_TO_FORMAT: Record<string, DocumentFormat> = {
  '.md': DocumentFormat.MD,
  '.markdown': DocumentFormat.MD,
  '.txt': DocumentFormat.TXT,
  '.docx': DocumentFormat.DOCX,
  '.odt': DocumentFormat.ODT,
  '.pdf': DocumentFormat.PDF,
};

// 允许的扩展名白名单（用于 controller 校验）
export const ALLOWED_EXTENSIONS = uploadConfig.allowedDocExtensions;

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(DocumentVersion)
    private readonly versionRepo: Repository<DocumentVersion>,
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
    private readonly textParser: TextParser,
    private readonly pandocParser: PandocParser,
    private readonly pdfParser: PdfParser,
  ) {}

  /**
   * 根据文件名扩展名解析 DocumentFormat
   */
  static resolveFormat(filename: string): DocumentFormat | null {
    const ext = path.extname(filename).toLowerCase();
    return EXT_TO_FORMAT[ext] ?? null;
  }

  /**
   * 上传文档入口
   * 1. 校验 file / 扩展名 / 分类
   * 2. 创建 Document 行（content=null, version=1）
   * 3. 写入原文件到 original/<docId>/<filename>
   * 4. 调用对应 parser 解析
   * 5. 更新 content / title
   * 6. 创建 version=1 的初始快照
   * 7. 失败时清理 original 文件与 Document 行
   */
  async ingest(
    file: Express.Multer.File,
    categoryId: string,
    userId: string,
    ownerType: DocumentOwnerType = DocumentOwnerType.PERSONAL,
    ownerId?: string,
  ): Promise<Document> {
    if (!file) {
      throw new BadRequestException('未提供上传文件');
    }

    const format = UploadsService.resolveFormat(file.originalname);
    if (!format) {
      throw new BadRequestException(
        `不支持的文件扩展名，允许：${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }

    // 校验分类存在
    const category = await this.categoryRepo.findOne({
      where: { id: categoryId },
    });
    if (!category) {
      throw new NotFoundException(`分类 ${categoryId} 不存在`);
    }

    // 标题先用文件名去 ext
    const ext = path.extname(file.originalname);
    const title =
      path.basename(file.originalname, ext) || file.originalname;

    // 1. 先创建 Document 行（content=null, originalPath=null, version=1）
    // createdBy 记录上传者，用于权限校验与"我的文档"视图
    // ownerType/ownerId 决定文档归属（personal=个人空间，group/department=组织空间）
    // contentSource 按格式预设：md/txt=manual，docx/odt=pandoc（索引文本），pdf=pdf_text
    const resolvedOwnerId =
      ownerType === DocumentOwnerType.PERSONAL ? userId : (ownerId ?? null);
    if (
      (ownerType === DocumentOwnerType.GROUP ||
        ownerType === DocumentOwnerType.DEPARTMENT) &&
      !resolvedOwnerId
    ) {
      throw new BadRequestException(
        `ownerType=${ownerType} 需提供 ownerId（组织节点 id）`,
      );
    }
    const initialContentSource =
      format === DocumentFormat.PDF
        ? ContentSource.PDF_TEXT
        : format === DocumentFormat.DOCX || format === DocumentFormat.ODT
          ? ContentSource.PANDOC
          : ContentSource.MANUAL;
    const doc = this.documentRepo.create({
      categoryId,
      title,
      content: null,
      format,
      originalPath: null,
      version: 1,
      createdBy: userId,
      ownerType,
      ownerId: resolvedOwnerId,
      contentSource: initialContentSource,
    });
    const saved = await this.documentRepo.save(doc);
    const docId = saved.id;

    const uploadDir = getUploadDir();
    const originalDir = path.join(uploadDir, 'original', docId);
    const originalFilename = `${docId}-${file.originalname}`;
    const originalAbs = path.join(originalDir, originalFilename);
    // 临时输入文件，供 parser 读取
    const tmpInput = path.join(originalDir, `input${ext}`);
    let wroteOriginal = false;
    let wroteTmpInput = false;

    try {
      // 2. 写入原文件
      await fs.mkdir(originalDir, { recursive: true });
      await fs.writeFile(originalAbs, file.buffer);
      wroteOriginal = true;

      // 3. 更新 originalPath
      const relativePath = `original/${docId}/${originalFilename}`;
      saved.originalPath = relativePath;
      await this.documentRepo.update(docId, { originalPath: relativePath });

      // 4. 写入临时输入文件供 parser 读取
      await fs.writeFile(tmpInput, file.buffer);
      wroteTmpInput = true;

      // 5. 按 format 调用对应 parser
      let result: { content: string | null; title?: string; pages?: number };
      try {
        if (format === DocumentFormat.MD || format === DocumentFormat.TXT) {
          result = await this.textParser.parse(tmpInput, docId, format);
        } else if (
          format === DocumentFormat.DOCX ||
          format === DocumentFormat.ODT
        ) {
          result = await this.pandocParser.parse(tmpInput, docId, format);
        } else {
          result = await this.pdfParser.parse(tmpInput, docId, format);
        }
      } finally {
        // 清理临时输入文件
        if (wroteTmpInput) {
          await fs.unlink(tmpInput).catch(() => undefined);
        }
      }

      // 6. 更新 content、（PDF 情况）title 与 pages 元信息
      const patch: Partial<Pick<Document, 'content' | 'title' | 'pages'>> = {
        content: result.content,
      };
      if (result.title) {
        patch.title = result.title;
      }
      if (typeof result.pages === 'number') {
        patch.pages = result.pages;
      }
      await this.documentRepo.update(docId, patch);
      saved.content = result.content;
      if (result.title) saved.title = result.title;
      if (typeof result.pages === 'number') saved.pages = result.pages;

      // 7. 创建 version=1 的初始快照
      await this.versionRepo.save(
        this.versionRepo.create({
          documentId: docId,
          version: 1,
          content: result.content ?? '',
        }),
      );

      return saved;
    } catch (err) {
      // 失败时清理已写入的 original 文件，避免脏数据
      if (wroteOriginal) {
        await fs.unlink(originalAbs).catch(() => undefined);
        // 顺便尝试删除空的 original/<docId>/ 目录
        await fs.rmdir(originalDir).catch(() => undefined);
      }
      // 删除已创建的 Document 行以保持一致
      await this.documentRepo.delete(docId).catch(() => undefined);

      this.logger.error(
        `文档解析失败 docId=${docId}：${(err as Error).message}`,
      );

      if (
        err instanceof BadRequestException ||
        err instanceof NotFoundException ||
        err instanceof InternalServerErrorException
      ) {
        throw err;
      }
      throw new InternalServerErrorException(
        `文档解析失败：${(err as Error).message}`,
      );
    }
  }

  /**
   * 上传图片入口
   * 仅接受 PNG/JPEG/GIF/WEBP，保存到 images/<docId|temp>/<uuid>.<ext>
   */
  async saveImage(
    file: Express.Multer.File,
    docId: string | null,
  ): Promise<{ url: string; filename: string }> {
    if (!file) {
      throw new BadRequestException('未提供上传图片');
    }
    const allowedMime = uploadConfig.allowedImageMimes;
    if (!allowedMime.includes(file.mimetype)) {
      throw new BadRequestException('仅支持 PNG/JPEG/GIF/WEBP 图片');
    }

    const uploadDir = getUploadDir();
    const scope = docId ?? 'temp';
    const targetDir = path.join(uploadDir, 'images', scope);
    await fs.mkdir(targetDir, { recursive: true });

    // 取扩展名：优先 originalname 的 ext，否则按 MIME 推断
    const extFromName = path.extname(file.originalname);
    const ext =
      extFromName ||
      `.${(file.mimetype.split('/')[1] || 'png').toLowerCase()}`;
    const filename = `${randomUUID()}${ext}`;
    const absPath = path.join(targetDir, filename);
    await fs.writeFile(absPath, file.buffer);

    return {
      // 走鉴权文件接口，前端渲染时拼 ?token=<fileToken>
      url: `/api/files/${scope}/image/${filename}`,
      filename,
    };
  }
}

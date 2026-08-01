import {
  BadRequestException,
  ForbiddenException,
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
import { DocumentAttachment, AttachmentType } from '../documents/document-attachment.entity';
import { Category } from '../categories/category.entity';
import { TextParser } from './parsers/text.parser';
import { PandocParser } from './parsers/pandoc.parser';
import { PdfParser } from './parsers/pdf.parser';
import { DoclingParser } from './parsers/docling.parser';
import { getUploadDir, uploadConfig } from '../config/upload.config';
import { doclingConfig } from '../config/docling.config';
import { AccessControlService } from '../organizations/access-control.service';
import { AuthUser } from '../common/decorators/current-user.decorator';

// 扩展名 → DocumentFormat 映射（含 kkFileView 支持的 office 类 + 版式 + 模板格式）
const EXT_TO_FORMAT: Record<string, DocumentFormat> = {
  '.md': DocumentFormat.MD,
  '.markdown': DocumentFormat.MD,
  '.txt': DocumentFormat.TXT,
  '.docx': DocumentFormat.DOCX,
  '.odt': DocumentFormat.ODT,
  '.pdf': DocumentFormat.PDF,
  // office 类（正文不可解析，仅 kkFileView 预览）
  '.doc': DocumentFormat.DOC,
  '.xls': DocumentFormat.XLS,
  '.xlsx': DocumentFormat.XLSX,
  '.ppt': DocumentFormat.PPT,
  '.pptx': DocumentFormat.PPTX,
  '.csv': DocumentFormat.CSV,
  '.tsv': DocumentFormat.TSV,
  '.wps': DocumentFormat.WPS,
  '.dps': DocumentFormat.DPS,
  '.et': DocumentFormat.ET,
  '.ett': DocumentFormat.ETT,
  '.wpt': DocumentFormat.WPT,
  '.ods': DocumentFormat.ODS,
  '.odp': DocumentFormat.ODP,
  '.ott': DocumentFormat.OTT,
  '.fodt': DocumentFormat.FODT,
  '.fods': DocumentFormat.FODS,
  // 版式/富文本
  '.ofd': DocumentFormat.OFD,
  '.rtf': DocumentFormat.RTF,
  // Office 宏/模板
  '.xlsm': DocumentFormat.XLSM,
  '.dotm': DocumentFormat.DOTM,
  '.xlt': DocumentFormat.XLT,
  '.xltm': DocumentFormat.XLTM,
  '.dot': DocumentFormat.DOT,
  '.xlam': DocumentFormat.XLAM,
  '.dotx': DocumentFormat.DOTX,
  '.xla': DocumentFormat.XLA,
  '.pptm': DocumentFormat.PPTM,
  // OpenOffice 模板
  '.ots': DocumentFormat.OTS,
  '.otp': DocumentFormat.OTP,
  '.six': DocumentFormat.SIX,
};

// 允许的扩展名白名单（用于 controller 校验）
export const ALLOWED_EXTENSIONS = uploadConfig.allowedDocExtensions;

// 可解析正文的格式（其他格式 content 为空，仅 kkFileView 预览）
// csv/tsv 是纯文本，走 TextParser 直接读 utf-8 入索引（仅检索用，编辑走 OnlyOffice cell）
const PARSEABLE_FORMATS = new Set<DocumentFormat>([
  DocumentFormat.MD,
  DocumentFormat.TXT,
  DocumentFormat.CSV,
  DocumentFormat.TSV,
  DocumentFormat.DOCX,
  DocumentFormat.ODT,
  DocumentFormat.PDF,
]);

/**
 * 清洗 multer 给的 originalname，防止路径穿越：
 * - 取 basename，剥离目录
 * - 替换 .. / 空字节 等危险字符
 * 用于落盘文件名拼接，避免写入到 original/<docId>/ 之外
 */
function sanitizeFilename(name: string): string {
  // basename 防穿越，并去除首尾空白
  const base = path.basename(name ?? '').trim();
  // 替换路径穿越/控制字符为下划线
  return base
    .replace(/\.\./g, '_')
    .replace(/[\0\r\n]/g, '_')
    .replace(/[\\/]/g, '_');
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(DocumentVersion)
    private readonly versionRepo: Repository<DocumentVersion>,
    @InjectRepository(DocumentAttachment)
    private readonly attachRepo: Repository<DocumentAttachment>,
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
    private readonly textParser: TextParser,
    private readonly pandocParser: PandocParser,
    private readonly pdfParser: PdfParser,
    private readonly doclingParser: DoclingParser,
    private readonly accessControl: AccessControlService,
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
    user: AuthUser,
    ownerType: DocumentOwnerType = DocumentOwnerType.PERSONAL,
    ownerId?: string,
    isCollection = false,
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

    // 清洗文件名，防止路径穿越（originalname 来自 multer，未经清洗）
    // multer 的 originalname 默认按 latin1 解码，中文文件名（UTF-8）会被当 latin1 导致乱码，
    // 需先将 latin1 字节还原为 UTF-8（纯 ASCII 文件名不受影响）
    const safeOriginalName = sanitizeFilename(
      Buffer.from(file.originalname, 'latin1').toString('utf8'),
    );
    // 标题先用文件名去 ext
    const ext = path.extname(safeOriginalName);
    const title =
      path.basename(safeOriginalName, ext) || safeOriginalName || '未命名文档';

    // 1. 先创建 Document 行（content=null, originalPath=null, version=1）
    // createdBy 记录上传者，用于权限校验与"我的文档"视图
    // ownerType/ownerId 决定文档归属（personal=个人空间，group/department=组织空间）
    // contentSource 按格式预设：md/txt=manual，docx/odt=pandoc（索引文本），pdf=pdf_text
    const resolvedOwnerId =
      ownerType === DocumentOwnerType.PERSONAL ? user.id : (ownerId ?? null);
    if (
      (ownerType === DocumentOwnerType.GROUP ||
        ownerType === DocumentOwnerType.DEPARTMENT) &&
      !resolvedOwnerId
    ) {
      throw new BadRequestException(
        `ownerType=${ownerType} 需提供 ownerId（组织节点 id）`,
      );
    }
    // 安全：group/department 归属需校验当前用户对该组织节点有写权限，
    // 防止 editor 向无权访问的组织空间注入文档（跨组织数据投毒）
    if (
      (ownerType === DocumentOwnerType.GROUP ||
        ownerType === DocumentOwnerType.DEPARTMENT) &&
      resolvedOwnerId
    ) {
      const canWriteOrg = await this.accessControl.canWrite(user, {
        ownerType,
        ownerId: resolvedOwnerId,
        createdBy: user.id,
      });
      if (!canWriteOrg) {
        throw new ForbiddenException(
          `无权向组织节点 ${resolvedOwnerId} 上传文档`,
        );
      }
    }
    // contentSource 按格式预设：
    // - 可解析格式：md/txt/csv/tsv=manual，docx/odt=pandoc，pdf=pdf_text
    // - 不可解析格式（office 类）：content 为空，仅 kkFileView 预览，标记为 manual
    const isParseable = PARSEABLE_FORMATS.has(format);
    const initialContentSource =
      !isParseable
        ? ContentSource.MANUAL
        : format === DocumentFormat.PDF
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
      createdBy: user.id,
      ownerType,
      ownerId: resolvedOwnerId,
      contentSource: initialContentSource,
      isCollection: isCollection || undefined,
    });
    const saved = await this.documentRepo.save(doc);
    const docId = saved.id;

    const uploadDir = getUploadDir();
    const originalDir = path.join(uploadDir, 'original', docId);
    // 落盘文件名用 docId + 清洗后的纯文件名，杜绝任何穿越可能
    const originalFilename = `${docId}-${safeOriginalName}`;
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
      //    不可解析格式（office 类：doc/xls/xlsx/ppt/pptx/csv/tsv/wps/dps/et/ett/wpt/ods/odp/ott/fodt/fods）
      //    跳过 parser，content 为空，仅 kkFileView 预览。
      //    可解析格式：md/txt/csv/tsv 走 TextParser（纯文本直读 utf-8）；
      //    docx/odt/pdf 优先 docling，回退 pandoc/pdf-parse
      let result: { content: string | null; title?: string; pages?: number };
      let usedDocling = false;
      try {
        if (!isParseable) {
          // 不可解析格式：不调用 parser，content 为空
          result = { content: null };
        } else if (
          format === DocumentFormat.MD ||
          format === DocumentFormat.TXT ||
          format === DocumentFormat.CSV ||
          format === DocumentFormat.TSV
        ) {
          // 纯文本类：直接读 utf-8，不走 docling（csv/tsv docling 会转 markdown 表格，破坏原始内容）
          result = await this.textParser.parse(tmpInput, docId, format);
        } else if (doclingConfig.enabled) {
          try {
            result = await this.doclingParser.parse(tmpInput, docId, format);
            usedDocling = true;
          } catch (e) {
            this.logger.warn(
              `docling 解析失败，回退到本地解析器：${(e as Error).message}`,
            );
            result = await this.fallbackParse(tmpInput, docId, format);
          }
        } else {
          result = await this.fallbackParse(tmpInput, docId, format);
        }
      } finally {
        // 清理临时输入文件
        if (wroteTmpInput) {
          await fs.unlink(tmpInput).catch(() => undefined);
        }
      }

      // 6. 更新 content、（PDF 情况）title 与 pages 元信息
      const patch: Partial<
        Pick<Document, 'content' | 'title' | 'pages' | 'contentSource'>
      > = {
        content: result.content,
      };
      if (result.title) {
        patch.title = result.title;
      }
      if (typeof result.pages === 'number') {
        patch.pages = result.pages;
      }
      // docling 解析成功时覆盖 contentSource（initialContentSource 按格式预设，此处校正为 docling）
      if (usedDocling) {
        patch.contentSource = ContentSource.DOCLING;
      }
      await this.documentRepo.update(docId, patch);
      saved.content = result.content;
      if (result.title) saved.title = result.title;
      if (typeof result.pages === 'number') saved.pages = result.pages;
      if (usedDocling) saved.contentSource = ContentSource.DOCLING;

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
   * 本地回退解析器（docling 不可用时使用）
   * docx/odt → pandoc，pdf → pdf-parse
   */
  private async fallbackParse(
    filePath: string,
    docId: string,
    format: DocumentFormat,
  ): Promise<{ content: string | null; title?: string; pages?: number }> {
    if (format === DocumentFormat.DOCX || format === DocumentFormat.ODT) {
      return this.pandocParser.parse(filePath, docId, format);
    }
    return this.pdfParser.parse(filePath, docId, format);
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

    // 安全：扩展名按 MIME 严格映射（不信任 originalname 的扩展名），
    // 防止 svg/html 伪装成图片落盘后被浏览器以可执行 Content-Type 渲染（XSS）
    const mimeToExt: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
    };
    const ext = mimeToExt[file.mimetype] ?? '.png';
    const filename = `${randomUUID()}${ext}`;
    const absPath = path.join(targetDir, filename);
    await fs.writeFile(absPath, file.buffer);

    return {
      // 走鉴权文件接口，前端渲染时拼 ?token=<fileToken>
      url: `/api/files/${scope}/image/${filename}`,
      filename,
    };
  }

  /**
   * 创建文档集（无文件，主文档 isCollection=true，正文为空）
   * 由 uploads.controller POST /collection 调用
   * - 校验分类存在
   * - 校验组织归属权限（与 ingest 同逻辑）
   * - 创建 Document（format=MD 占位，content=null，isCollection=true）
   * - 创建首版本快照（version=1, content=''）
   * - 把成员文档引用到集合（attach_type=document）
   */
  async createCollection(
    title: string,
    categoryId: string,
    memberDocIds: string[],
    user: AuthUser,
    ownerType: DocumentOwnerType = DocumentOwnerType.PERSONAL,
    ownerId?: string,
  ): Promise<Document> {
    if (!title?.trim()) {
      throw new BadRequestException('集合标题不能为空');
    }
    // 校验分类存在
    const category = await this.categoryRepo.findOne({
      where: { id: categoryId },
    });
    if (!category) {
      throw new NotFoundException(`分类 ${categoryId} 不存在`);
    }

    // 校验组织归属权限（与 ingest 同逻辑）
    const resolvedOwnerId =
      ownerType === DocumentOwnerType.PERSONAL ? user.id : (ownerId ?? null);
    if (
      (ownerType === DocumentOwnerType.GROUP ||
        ownerType === DocumentOwnerType.DEPARTMENT) &&
      !resolvedOwnerId
    ) {
      throw new BadRequestException(
        `ownerType=${ownerType} 需提供 ownerId（组织节点 id）`,
      );
    }
    if (
      (ownerType === DocumentOwnerType.GROUP ||
        ownerType === DocumentOwnerType.DEPARTMENT) &&
      resolvedOwnerId
    ) {
      const canWriteOrg = await this.accessControl.canWrite(user, {
        ownerType,
        ownerId: resolvedOwnerId,
        createdBy: user.id,
      });
      if (!canWriteOrg) {
        throw new ForbiddenException(
          `无权向组织节点 ${resolvedOwnerId} 创建文档集`,
        );
      }
    }

    // 创建集合主文档（format=MD 占位，content=null）
    const collection = this.documentRepo.create({
      categoryId,
      title: title.trim(),
      content: null,
      format: DocumentFormat.MD,
      originalPath: null,
      version: 1,
      createdBy: user.id,
      ownerType,
      ownerId: resolvedOwnerId,
      contentSource: ContentSource.MANUAL,
      isCollection: true,
    });
    const saved = await this.documentRepo.save(collection);

    // 创建首版本快照（与普通文档一致）
    await this.versionRepo.save(
      this.versionRepo.create({
        documentId: saved.id,
        version: 1,
        content: '',
      }),
    );

    // 把成员文档引用到集合（过滤掉不存在的）
    const validMemberIds: string[] = [];
    for (let i = 0; i < memberDocIds.length; i++) {
      const mid = memberDocIds[i];
      if (mid === saved.id) continue; // 不能引用自己
      const linked = await this.documentRepo.findOne({ where: { id: mid } });
      if (!linked) continue;
      validMemberIds.push(mid);
      await this.attachRepo.save(
        this.attachRepo.create({
          documentId: saved.id,
          attachType: AttachmentType.DOCUMENT,
          name: linked.title,
          filePath: null,
          fileSize: null,
          fileExt: null,
          linkedDocumentId: mid,
          sort: i + 1,
          createdBy: user.id,
        }),
      );
    }

    this.logger.log(
      `用户 ${user.id} 创建文档集 ${saved.id}（${title}），有效成员 ${validMemberIds.length} 个`,
    );
    return saved;
  }
}

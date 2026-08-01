import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentAttachment, AttachmentType } from './document-attachment.entity';
import { Document } from './document.entity';
import { AccessControlService } from '../organizations/access-control.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { getUploadDir, uploadConfig } from '../config/upload.config';
import { kkfileviewConfig } from '../config/kkfileview.config';
import { onlyofficeConfig } from '../config/onlyoffice.config';
import { FilesService } from '../files/files.service';

/**
 * 附件管理 Service
 *
 * 统一处理两种附件：
 * 1. file 类型：上传附件文件到主文档（代码/工具/测试包等）
 * 2. document 类型：把另一个文档引用为文档集成员
 *
 * 权限：附件权限完全继承主文档（documentId 指向的文档）。
 *      所有操作先校验对主文档的读写权限。
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    @InjectRepository(DocumentAttachment)
    private readonly attachRepo: Repository<DocumentAttachment>,
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    private readonly accessControl: AccessControlService,
    private readonly filesService: FilesService,
  ) {}

  /**
   * 校验对主文档的写权限，返回主文档
   */
  private async assertCanWriteMainDoc(docId: string, user: AuthUser): Promise<Document> {
    const doc = await this.docRepo.findOne({ where: { id: docId } });
    if (!doc) throw new NotFoundException(`主文档 ${docId} 不存在`);
    await this.accessControl.assertCanWrite(user, doc);
    return doc;
  }

  /**
   * 校验对主文档的读权限，返回主文档
   */
  private async assertCanReadMainDoc(docId: string, user: AuthUser): Promise<Document> {
    const doc = await this.docRepo.findOne({ where: { id: docId } });
    if (!doc) throw new NotFoundException(`主文档 ${docId} 不存在`);
    this.accessControl.assertCanRead(user, doc);
    return doc;
  }

  /**
   * 列出文档的附件（含 file 和 document 类型）
   *
   * 聚合规则（实现"文档集附件与所有成员关联"语义）：
   * 1. 该文档自己的附件（document_id = docId）
   * 2. 若该文档是某个集合的成员（被某集合主文档通过 document 类型附件引用），
   *    则 union 该集合主文档的所有 file 类型附件（集合共享附件）
   *
   * 读权限：校验传入的 docId（成员文档或主文档都可），集合主文档的附件
   *         因为成员可读 ⇒ 对集合主文档也间接可读（成员引用即授权）
   */
  async listByDoc(docId: string, user: AuthUser): Promise<DocumentAttachment[]> {
    await this.assertCanReadMainDoc(docId, user);

    // 1. 该文档自己的附件
    const ownAttachments = await this.attachRepo.find({
      where: { documentId: docId },
      order: { sort: 'ASC', createdAt: 'ASC' },
    });

    // 2. 查找该文档所属的所有集合主文档（作为成员被引用）
    //    一条 document 类型附件记录 = 一次集合成员引用：document_id=集合主文档, linked_document_id=成员文档
    const collectionLinks = await this.attachRepo.find({
      where: { linkedDocumentId: docId, attachType: AttachmentType.DOCUMENT },
      select: ['documentId'],
    });
    const collectionMainDocIds = Array.from(
      new Set(collectionLinks.map((l) => l.documentId)),
    );

    // 3. 聚合每个集合主文档的 file 类型附件（集合共享附件）
    const collectionAttachments: DocumentAttachment[] = [];
    for (const mainId of collectionMainDocIds) {
      const atts = await this.attachRepo.find({
        where: { documentId: mainId, attachType: AttachmentType.FILE },
        order: { sort: 'ASC', createdAt: 'ASC' },
      });
      collectionAttachments.push(...atts);
    }

    // 4. 合并去重（按 id），按 sort/createdAt 排序
    const allMap = new Map<string, DocumentAttachment>();
    for (const a of ownAttachments) allMap.set(a.id, a);
    for (const a of collectionAttachments) allMap.set(a.id, a);
    return Array.from(allMap.values()).sort(
      (a, b) => a.sort - b.sort || a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  /**
   * 上传附件文件（file 类型）
   * - 落盘到 attachments/<docId>/<filename>
   * - 校验扩展名在 allowedAttachmentExtensions 白名单内
   * - 校验对主文档的写权限
   */
  async uploadFile(
    docId: string,
    file: Express.Multer.File,
    user: AuthUser,
    sort = 0,
  ): Promise<DocumentAttachment> {
    await this.assertCanWriteMainDoc(docId, user);

    if (!file) throw new BadRequestException('未提供附件文件');
    // 清洗文件名（与 uploads.service 同逻辑）
    const safeName = sanitizeFilename(
      Buffer.from(file.originalname, 'latin1').toString('utf8'),
    );
    const ext = path.extname(safeName).toLowerCase();
    if (!uploadConfig.allowedAttachmentExtensions.includes(ext)) {
      throw new BadRequestException(
        `不支持的附件扩展名 ${ext}，允许：${uploadConfig.allowedAttachmentExtensions.join(', ')}`,
      );
    }

    // 落盘到 attachments/<docId>/<uuid>-<safeName>
    const attachDir = path.join(getUploadDir(), 'attachments', docId);
    await fs.mkdir(attachDir, { recursive: true });
    const fileName = `${crypto.randomUUID()}-${safeName}`;
    const absPath = path.join(attachDir, fileName);
    await fs.writeFile(absPath, file.buffer);
    const relativePath = `attachments/${docId}/${fileName}`;

    // 计算下一个 sort 值（若未指定）
    const finalSort = sort || (await this.nextSort(docId));

    const attach = this.attachRepo.create({
      documentId: docId,
      attachType: AttachmentType.FILE,
      name: safeName,
      filePath: relativePath,
      fileSize: file.size,
      fileExt: ext,
      sort: finalSort,
      createdBy: user.id,
    });
    const saved = await this.attachRepo.save(attach);
    this.logger.log(`用户 ${user.id} 上传附件到文档 ${docId}：${safeName} (${file.size} bytes)`);
    return saved;
  }

  /**
   * 把另一个文档引用为文档集成员（document 类型）
   * - 主文档必须是文档集（isCollection=true）
   * - 不能引用自己、不能重复引用
   */
  async linkDocument(
    docId: string,
    linkedDocumentId: string,
    user: AuthUser,
    sort = 0,
  ): Promise<DocumentAttachment> {
    const mainDoc = await this.assertCanWriteMainDoc(docId, user);
    if (!mainDoc.isCollection) {
      throw new BadRequestException('主文档不是文档集，无法添加成员文档');
    }
    if (docId === linkedDocumentId) {
      throw new BadRequestException('不能把文档集自身引用为成员');
    }
    const linked = await this.docRepo.findOne({ where: { id: linkedDocumentId } });
    if (!linked) throw new NotFoundException(`被引用文档 ${linkedDocumentId} 不存在`);

    // 检查是否已引用
    const exists = await this.attachRepo.findOne({
      where: { documentId: docId, linkedDocumentId },
    });
    if (exists) throw new BadRequestException('该文档已是集合成员');

    const finalSort = sort || (await this.nextSort(docId));

    const attach = this.attachRepo.create({
      documentId: docId,
      attachType: AttachmentType.DOCUMENT,
      name: linked.title,
      filePath: null,
      fileSize: null,
      fileExt: null,
      linkedDocumentId,
      sort: finalSort,
      createdBy: user.id,
    });
    const saved = await this.attachRepo.save(attach);
    this.logger.log(`用户 ${user.id} 把文档 ${linkedDocumentId} 加入集合 ${docId}`);
    return saved;
  }

  /**
   * 删除附件 / 移出集合
   * - file 类型：同时删除落盘文件
   * - document 类型：仅删除引用记录（不影响被引用文档）
   */
  async remove(attachId: string, user: AuthUser): Promise<void> {
    const attach = await this.attachRepo.findOne({ where: { id: attachId } });
    if (!attach) throw new NotFoundException(`附件 ${attachId} 不存在`);
    await this.assertCanWriteMainDoc(attach.documentId, user);

    // file 类型：删除落盘文件
    if (attach.attachType === AttachmentType.FILE && attach.filePath) {
      const absPath = path.join(getUploadDir(), attach.filePath);
      await fs.unlink(absPath).catch(() => undefined);
    }

    await this.attachRepo.delete(attachId);
    this.logger.log(`用户 ${user.id} 删除附件 ${attachId}（类型 ${attach.attachType}）`);
  }

  /**
   * 更新附件排序
   */
  async updateSort(attachId: string, sort: number, user: AuthUser): Promise<void> {
    const attach = await this.attachRepo.findOne({ where: { id: attachId } });
    if (!attach) throw new NotFoundException(`附件 ${attachId} 不存在`);
    await this.assertCanWriteMainDoc(attach.documentId, user);
    await this.attachRepo.update({ id: attachId }, { sort });
  }

  /**
   * 获取附件的 kkFileView 预览 URL（仅 file 类型）
   * 复用主文档的读权限校验 + 文件 token 机制
   */
  async getAttachmentKkViewUrl(
    attachId: string,
    user: AuthUser,
  ): Promise<string> {
    if (!kkfileviewConfig.enabled) {
      throw new BadRequestException('kkFileView 未启用');
    }
    const attach = await this.attachRepo.findOne({ where: { id: attachId } });
    if (!attach) throw new NotFoundException(`附件 ${attachId} 不存在`);
    if (attach.attachType !== AttachmentType.FILE) {
      throw new BadRequestException('document 类型附件无文件预览，请直接访问成员文档');
    }
    // 校验对主文档的读权限
    await this.assertCanReadMainDoc(attach.documentId, user);
    if (!attach.filePath) throw new NotFoundException('附件文件路径缺失');

    // 用主文档 id 签发 token（附件下载端点校验主文档 token）
    const fileToken = this.filesService.signFileToken(attach.documentId, user.id);
    // 附件下载 URL：/api/files/:docId/attachment/:attachId?token=...
    const fileDownloadUrl = `${onlyofficeConfig.backendPublicUrl}/api/files/${attach.documentId}/attachment/${attachId}?token=${encodeURIComponent(fileToken)}`;
    // 附 fullfilename 让 kkFileView 识别类型
    const fullFileName = attach.name;
    const fileUrlWithHint = `${fileDownloadUrl}&fullfilename=${encodeURIComponent(fullFileName)}`;
    const encoded = Buffer.from(fileUrlWithHint).toString('base64');
    return `${kkfileviewConfig.publicUrl}/onlinePreview?url=${encodeURIComponent(encoded)}`;
  }

  /**
   * 获取附件文件的绝对路径（供 files.controller 下载端点调用）
   * 调用方需自行校验 token（主文档的文件 token）
   */
  async getAttachmentAbsPath(attachId: string): Promise<string> {
    const attach = await this.attachRepo.findOne({ where: { id: attachId } });
    if (!attach || attach.attachType !== AttachmentType.FILE || !attach.filePath) {
      throw new NotFoundException(`附件 ${attachId} 不存在或非文件类型`);
    }
    const absPath = path.join(getUploadDir(), attach.filePath);
    return absPath;
  }

  private async nextSort(docId: string): Promise<number> {
    const last = await this.attachRepo.findOne({
      where: { documentId: docId },
      order: { sort: 'DESC' },
    });
    return (last?.sort ?? 0) + 1;
  }
}

/**
 * 清洗 multer 给的 originalname，防止路径穿越
 * 与 uploads.service 同逻辑
 */
function sanitizeFilename(name: string): string {
  const base = path.basename(name ?? '').trim();
  return base
    .replace(/\.\.+/g, '_')
    .replace(/[\x00-\x1f]/g, '_')
    .replace(/[\\/:*?"<>|]/g, '_');
}

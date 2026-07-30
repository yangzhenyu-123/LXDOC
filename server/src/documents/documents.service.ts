import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Document, DocumentFormat } from './document.entity';
import { DocumentVersion } from './document-version.entity';
import { Category } from '../categories/category.entity';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { getUploadDir } from '../config/upload.config';

/**
 * 当前登录用户的最小结构（仅用于权限校验）
 */
interface CurrentUser {
  id: string;
  role: string;
}

/**
 * 文档版本列表响应（不含 content，避免大响应）
 */
export interface DocumentVersionListItem {
  id: string;
  version: number;
  createdAt: Date;
}

/**
 * 单个版本内容响应
 */
export interface DocumentVersionContent {
  version: number;
  content: string;
  createdAt: Date;
}

/**
 * 分类下文档列表项（不含 content）
 */
export interface DocumentListItem {
  id: string;
  title: string;
  format: string;
  version: number;
  tags: string[];
  updatedAt: Date;
  createdBy: string | null;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(DocumentVersion)
    private readonly versionRepo: Repository<DocumentVersion>,
    private readonly entityManager: EntityManager,
  ) {}

  /**
   * 获取单个文档（含 content）
   */
  async findOne(id: string): Promise<Document> {
    const doc = await this.documentRepo.findOne({ where: { id } });
    if (!doc) {
      throw new NotFoundException(`文档 ${id} 不存在`);
    }
    return doc;
  }

  /**
   * 获取 docx / odt 文档的 HTML 预览片段
   * 1. 校验文档存在、格式为 docx/odt、原文件存在
   * 2. 调用 pandoc 转 HTML（不加 standalone，输出即 body 片段）
   * 3. 把图片相对路径替换为 /uploads/images/<docId>/xxx
   * 4. 返回 HTML 字符串
   */
  async getPreviewHtml(id: string): Promise<string> {
    const doc = await this.findOne(id);

    if (
      doc.format !== DocumentFormat.DOCX &&
      doc.format !== DocumentFormat.ODT
    ) {
      throw new BadRequestException('仅支持 docx/odt 预览');
    }

    if (!doc.originalPath) {
      throw new NotFoundException(`文档 ${id} 缺少原始文件`);
    }

    const absPath = path.join(getUploadDir(), doc.originalPath);
    if (!existsSync(absPath)) {
      throw new NotFoundException(`原始文件不存在：${doc.originalPath}`);
    }

    const fromFormat = doc.format === DocumentFormat.DOCX ? 'docx' : 'odt';
    let html = '';
    try {
      html = await this.runPandocToHtml(fromFormat, absPath);
    } catch (err) {
      // 已是 Nest 异常则原样抛出
      if (
        err instanceof InternalServerErrorException ||
        (err as Error)?.name === 'InternalServerErrorException'
      ) {
        throw err;
      }
      throw new InternalServerErrorException(
        `Pandoc 转 HTML 失败：${(err as Error).message}`,
      );
    }

    // 改写图片 src：./media/xxx / media/xxx / images/xxx → /uploads/images/<docId>/xxx
    html = html.replace(
      /src=["']\.?\/?(?:media\/|images\/)?([^"']+)["']/g,
      (_match, name: string) =>
        `src="/uploads/images/${id}/${name}"`,
    );

    return html;
  }

  /**
   * 调用 pandoc 将文档转换为 HTML 片段（不带 standalone）
   * 用 execFile 包装 Promise，超时 60s
   * pandoc 未安装时抛 InternalServerErrorException('Pandoc 未安装')
   */
  private runPandocToHtml(fromFormat: string, filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'pandoc',
        ['-f', fromFormat, '-t', 'html', filePath],
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
          resolve(stdout);
        },
      );
    });
  }

  /**
   * 更新文档（事务）
   * 1. 写入当前内容的版本快照（version=当前 version，若已存在则跳过）
   * 2. 更新 Document 的 title/content/tags（若提供），version + 1
   * 权限：admin 全权；editor 仅能改自己 createdBy 的文档；其他拒绝
   */
  async update(
    id: string,
    dto: UpdateDocumentDto,
    currentUser: CurrentUser,
  ): Promise<Document> {
    const doc = await this.findOne(id);
    this.assertCanWrite(doc, currentUser);

    return this.entityManager.transaction(async (manager) => {
      const docRepo = manager.getRepository(Document);
      const versionRepo = manager.getRepository(DocumentVersion);

      // 1. 写入当前内容快照（version=当前 version）
      // 若该版本已存在（例如从未修改过、version=1 的初始快照），则跳过
      const existing = await versionRepo.findOne({
        where: { documentId: id, version: doc.version },
      });
      if (!existing) {
        await versionRepo.save(
          versionRepo.create({
            documentId: id,
            version: doc.version,
            content: doc.content ?? '',
            snapshotPath: null,
          }),
        );
      }

      // 2. 更新 Document
      const patch: Partial<Document> = {
        version: doc.version + 1,
        updatedAt: new Date(),
      };
      if (dto.title !== undefined) patch.title = dto.title;
      if (dto.content !== undefined) patch.content = dto.content;
      if (dto.tags !== undefined) patch.tags = dto.tags;

      await docRepo.update(id, patch);
      const updated = await docRepo.findOne({ where: { id } });
      return updated as Document;
    });
  }

  /**
   * 列出文档的所有版本（按 version DESC），不含 content
   */
  async listVersions(id: string): Promise<DocumentVersionListItem[]> {
    // 校验文档存在
    await this.findOne(id);
    const versions = await this.versionRepo.find({
      where: { documentId: id },
      order: { version: 'DESC' },
      select: ['id', 'version', 'createdAt'],
    });
    return versions.map((v) => ({
      id: v.id,
      version: v.version,
      createdAt: v.createdAt,
    }));
  }

  /**
   * 获取指定版本内容
   */
  async getVersion(
    id: string,
    version: number,
  ): Promise<DocumentVersionContent> {
    // 校验文档存在
    await this.findOne(id);
    const v = await this.versionRepo.findOne({
      where: { documentId: id, version },
    });
    if (!v) {
      throw new NotFoundException(
        `文档 ${id} 不存在版本 ${version}`,
      );
    }
    return {
      version: v.version,
      content: v.content,
      createdAt: v.createdAt,
    };
  }

  /**
   * 回滚到指定版本（事务）
   * 1. 找到目标版本的 content
   * 2. 写入当前内容快照（version=当前 version，若已存在则跳过）
   * 3. 更新 Document.content = 目标 content、version + 1
   * 权限：admin 全权；editor 仅能回滚自己 createdBy 的文档；其他拒绝
   */
  async rollback(
    id: string,
    version: number,
    currentUser: CurrentUser,
  ): Promise<Document> {
    const doc = await this.findOne(id);
    this.assertCanWrite(doc, currentUser);
    const target = await this.versionRepo.findOne({
      where: { documentId: id, version },
    });
    if (!target) {
      throw new NotFoundException(
        `文档 ${id} 不存在版本 ${version}`,
      );
    }

    return this.entityManager.transaction(async (manager) => {
      const docRepo = manager.getRepository(Document);
      const versionRepo = manager.getRepository(DocumentVersion);

      // 写入当前内容快照
      const existing = await versionRepo.findOne({
        where: { documentId: id, version: doc.version },
      });
      if (!existing) {
        await versionRepo.save(
          versionRepo.create({
            documentId: id,
            version: doc.version,
            content: doc.content ?? '',
            snapshotPath: null,
          }),
        );
      }

      // 更新 Document.content 为目标版本内容，version + 1
      await docRepo.update(id, {
        content: target.content,
        version: doc.version + 1,
        updatedAt: new Date(),
      });

      const updated = await docRepo.findOne({ where: { id } });
      return updated as Document;
    });
  }

  /**
   * 删除文档（事务）
   * 1. 校验权限：admin 全权；editor 仅可删自己 createdBy 的文档；其他拒绝
   * 2. 删除关联的 DocumentVersion 记录
   * 3. 删除 Document 记录
   * 4. best-effort 清理磁盘上的原文件与图片目录（失败仅记日志，不阻断删除）
   */
  async remove(
    id: string,
    currentUser: CurrentUser,
  ): Promise<void> {
    const doc = await this.findOne(id);
    this.assertCanWrite(doc, currentUser);

    await this.entityManager.transaction(async (manager) => {
      const docRepo = manager.getRepository(Document);
      const versionRepo = manager.getRepository(DocumentVersion);
      // 先删版本，再删文档
      await versionRepo.delete({ documentId: id });
      await docRepo.delete(id);
    });

    // best-effort 清理磁盘文件，失败不影响删除结果
    this.cleanupDocFiles(id, doc.originalPath).catch((err) => {
      this.logger.error(
        `清理文档文件失败 docId=${id}：${(err as Error).message}`,
      );
    });
  }

  /**
   * 清理文档对应的磁盘文件：original/<docId>/ 与 images/<docId>/
   * 文件缺失不视为错误（rm recursive + force）
   */
  private async cleanupDocFiles(
    docId: string,
    originalPath: string | null,
  ): Promise<void> {
    const uploadDir = getUploadDir();
    // 删除 original/<docId>/ 目录（含原文件与历史临时文件）
    const originalDir = path.join(uploadDir, 'original', docId);
    await fs.rm(originalDir, { recursive: true, force: true });
    // 删除 images/<docId>/ 目录（Pandoc 抽取的图片与编辑器上传的图片）
    const imagesDir = path.join(uploadDir, 'images', docId);
    await fs.rm(imagesDir, { recursive: true, force: true });
    // originalPath 为空时无需额外处理（已被目录删除覆盖）
    void originalPath;
  }

  /**
   * 列出最近更新的 N 篇文档（按 updatedAt DESC），不含 content
   * limit 上限 50，避免一次拉取过多
   */
  async findRecent(limit: number): Promise<DocumentListItem[]> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : 10;
    const docs = await this.documentRepo
      .createQueryBuilder('d')
      .select([
        'd.id',
        'd.title',
        'd.format',
        'd.version',
        'd.tags',
        'd.updatedAt',
        'd.createdBy',
      ])
      .orderBy('d.updatedAt', 'DESC')
      .limit(safeLimit)
      .getMany();

    return docs.map((d) => ({
      id: d.id,
      title: d.title,
      format: d.format,
      version: d.version,
      tags: d.tags ?? [],
      updatedAt: d.updatedAt,
      createdBy: d.createdBy,
    }));
  }

  /**
   * 列出某分类下的所有文档（不含 content）
   * 若 includeChildren=true，递归包含所有子分类下的文档
   */
  async listByCategory(
    categoryId: string,
    includeChildren = false,
  ): Promise<DocumentListItem[]> {
    let categoryIds: string[] = [categoryId];

    if (includeChildren) {
      // 服务层递归查询所有子孙分类 id
      categoryIds = await this.collectDescendantCategoryIds(categoryId);
    }

    const docs = await this.documentRepo
      .createQueryBuilder('d')
      .select([
        'd.id',
        'd.title',
        'd.format',
        'd.version',
        'd.tags',
        'd.updatedAt',
        'd.createdBy',
      ])
      .where('d.category_id IN (:...ids)', { ids: categoryIds })
      .orderBy('d.updatedAt', 'DESC')
      .getMany();

    return docs.map((d) => ({
      id: d.id,
      title: d.title,
      format: d.format,
      version: d.version,
      tags: d.tags ?? [],
      updatedAt: d.updatedAt,
      createdBy: d.createdBy,
    }));
  }

  /**
   * 校验当前用户是否可写指定文档
   * - admin 全权
   * - editor 仅当 document.createdBy === currentUser.id 时允许
   * - 其他（含 viewer）拒绝
   * 注意：findOne（GET 单个）等读操作不走此校验，所有登录用户可读任意文档（MVP 不做文档级读权限）
   */
  private assertCanWrite(doc: Document, currentUser: CurrentUser): void {
    if (currentUser.role === 'admin') {
      return;
    }
    if (
      currentUser.role === 'editor' &&
      doc.createdBy !== null &&
      doc.createdBy === currentUser.id
    ) {
      return;
    }
    throw new ForbiddenException('无权修改他人文档');
  }

  /**
   * 递归收集某分类的所有子孙分类 id（包含自身）
   * 采用服务层逐层查询，避免依赖数据库特定 CTE 语法
   */
  private async collectDescendantCategoryIds(
    rootId: string,
  ): Promise<string[]> {
    const result: string[] = [rootId];
    const queue: string[] = [rootId];
    const categoryRepo = this.entityManager.getRepository(Category);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = await categoryRepo.find({
        where: { parentId: currentId },
        select: ['id'],
      });
      for (const child of children) {
        result.push(child.id);
        queue.push(child.id);
      }
    }

    return result;
  }
}

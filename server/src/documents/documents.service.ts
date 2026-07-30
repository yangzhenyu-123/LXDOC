import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Document, DocumentFormat } from './document.entity';
import { DocumentVersion } from './document-version.entity';
import { Category } from '../categories/category.entity';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { getUploadDir } from '../config/upload.config';

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
   */
  async update(id: string, dto: UpdateDocumentDto): Promise<Document> {
    const doc = await this.findOne(id);

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
   */
  async rollback(id: string, version: number): Promise<Document> {
    const doc = await this.findOne(id);
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
    }));
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

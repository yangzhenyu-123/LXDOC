import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { JwtService } from '@nestjs/jwt';
import { Document, DocumentFormat, ContentSource } from './document.entity';
import { DocumentVersion } from './document-version.entity';
import { AccessControlService } from '../organizations/access-control.service';
import { FilesService } from '../files/files.service';
import { getUploadDir } from '../config/upload.config';
import { onlyofficeConfig } from '../config/onlyoffice.config';
import { AuthUser } from '../common/decorators/current-user.decorator';

/**
 * OnlyOffice 回调状态码
 * 详见 https://api.onlyoffice.com/editors/callback
 */
export enum OnlyOfficeStatus {
  /** 文档正在被编辑（无变化） */
  BEING_EDITED = 1,
  /** 文档已准备好保存 */
  SAVE = 2,
  /** 文档保存出错 */
  SAVE_CORRUPTED = 3,
  /** 文档关闭无变化 */
  CLOSED_NO_CHANGES = 4,
  /** 文档正在被编辑但被他人保存 */
  FORCE_SAVE = 6,
  /** 强制保存出错 */
  FORCE_SAVE_CORRUPTED = 7,
}

/**
 * OnlyOffice 回调请求体
 */
export interface OnlyOfficeCallbackPayload {
  /** 状态码 */
  status: OnlyOfficeStatus;
  /** 新文件下载地址（status=2/6 时存在） */
  url?: string;
  /** 文档 key */
  key: string;
  /** 用户 id */
  users?: string[];
  /** JWT 签名（OnlyOffice 启用 JWT 时） */
  token?: string;
}

/**
 * OnlyOffice 前端初始化 config（结构，未签名）
 * 详见 https://api.onlyoffice.com/editors/config/
 */
export interface OnlyOfficeConfig {
  documentType: 'word' | 'cell' | 'slide';
  document: {
    fileType: string;
    key: string;
    title: string;
    url: string;
    permissions: {
      edit: boolean;
      download: boolean;
      print: boolean;
      review: boolean;
    };
  };
  editorConfig: {
    mode: 'edit' | 'view';
    callbackUrl: string;
    lang: string;
    user: { id: string; name: string };
    customization?: {
      forcesave: boolean;
      autosave: boolean;
    };
  };
  /** 整个 config 经 JWT 签名后的 token，OnlyOffice 启用 JWT 时必填 */
  token?: string;
}

/**
 * OnlyOffice 集成服务
 *
 * 职责：
 * 1. 生成前端初始化 config（GET /documents/:id/onlyoffice/config）
 *    - 校验读权限；mode=edit 再校验写权限
 *    - 签发短期 fileUrl token（复用 FilesService.signFileToken）
 *    - 用 onlyofficeConfig.jwtSecret 签发整个 config 的 token
 * 2. 处理保存回调（POST /documents/:id/onlyoffice/callback）
 *    - 校验回调 JWT（OnlyOffice 用同一 jwtSecret 签）
 *    - status=2/6：下载 url → 覆盖 originalPath 文件 → version+1 → 写快照 → 重抽索引文本
 *
 * 设计：fileUrl/callbackUrl 走绝对 URL（OnlyOffice 容器需能访问后端），
 * 文件 token 用短期签名 URL（绑定 docId），避免暴露静态目录。
 */
@Injectable()
export class OnlyOfficeService {
  private readonly logger = new Logger(OnlyOfficeService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(DocumentVersion)
    private readonly versionRepo: Repository<DocumentVersion>,
    private readonly entityManager: EntityManager,
    private readonly accessControl: AccessControlService,
    private readonly filesService: FilesService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 生成 OnlyOffice 前端初始化 config
   * @param id 文档 id
   * @param user 当前用户
   * @param mode 编辑/查看模式（默认按权限决定）
   */
  async buildConfig(
    id: string,
    user: AuthUser,
    mode?: 'edit' | 'view',
  ): Promise<OnlyOfficeConfig> {
    const doc = await this.documentRepo.findOne({ where: { id } });
    if (!doc) {
      throw new NotFoundException(`文档 ${id} 不存在`);
    }
    if (doc.format !== DocumentFormat.DOCX && doc.format !== DocumentFormat.ODT) {
      throw new BadRequestException('OnlyOffice 仅支持 docx/odt');
    }
    if (!doc.originalPath) {
      throw new NotFoundException(`文档 ${id} 缺少原始文件`);
    }
    const absPath = path.join(getUploadDir(), doc.originalPath);
    if (!existsSync(absPath)) {
      throw new NotFoundException(`原始文件不存在：${doc.originalPath}`);
    }

    // 读权限必校验
    this.accessControl.assertCanRead(user, doc);

    // 决定 mode：显式指定优先；否则按写权限决定
    const canWrite = await this.accessControl.canWrite(user, doc);
    const finalMode: 'edit' | 'view' = mode ?? (canWrite ? 'edit' : 'view');
    if (finalMode === 'edit' && !canWrite) {
      throw new BadRequestException('无编辑权限，请使用 view 模式');
    }

    // 签发短期文件 token，拼装 OnlyOffice 可下载的绝对 URL
    const fileToken = this.filesService.signFileToken(id, user.id);
    const fileUrl = `${onlyofficeConfig.backendPublicUrl}/api/files/${id}/original?token=${encodeURIComponent(fileToken)}`;
    const callbackUrl = `${onlyofficeConfig.backendPublicUrl}/api/documents/${id}/onlyoffice/callback`;

    const config: OnlyOfficeConfig = {
      documentType: 'word',
      document: {
        fileType: doc.format,
        // key 随 version 变化，强制 OnlyOffice 重新加载
        key: `${id}#v${doc.version}`,
        title: `${doc.title}.${doc.format}`,
        url: fileUrl,
        permissions: {
          edit: finalMode === 'edit',
          download: true,
          print: true,
          review: finalMode === 'edit',
        },
      },
      editorConfig: {
        mode: finalMode,
        callbackUrl,
        lang: 'zh',
        user: { id: user.id, name: user.id },
        customization: {
          forcesave: true,
          autosave: true,
        },
      },
    };

    // 用 OnlyOffice JWT secret 签整个 config，写入 token 字段
    config.token = this.jwtService.sign(config as unknown as object, {
      secret: onlyofficeConfig.jwtSecret,
      expiresIn: '1h',
    });
    return config;
  }

  /**
   * 处理 OnlyOffice 回调
   * @returns {"error": 0 | 1} OnlyOffice 约定 error=0 表示成功
   */
  async handleCallback(
    id: string,
    payload: OnlyOfficeCallbackPayload,
  ): Promise<{ error: 0 | 1 }> {
    // 校验回调 JWT（OnlyOffice 启用 JWT 时会带 token 字段）
    this.verifyCallbackToken(payload);

    const doc = await this.documentRepo.findOne({ where: { id } });
    if (!doc) {
      this.logger.warn(`回调目标文档不存在：${id}`);
      return { error: 1 };
    }

    switch (payload.status) {
      case OnlyOfficeStatus.SAVE:
      case OnlyOfficeStatus.FORCE_SAVE: {
        if (!payload.url) {
          this.logger.warn(`回调 status=${payload.status} 但无 url，docId=${id}`);
          return { error: 1 };
        }
        try {
          await this.applySavedFile(doc, payload.url);
          return { error: 0 };
        } catch (err) {
          this.logger.error(
            `应用 OnlyOffice 保存失败 docId=${id}：${(err as Error).message}`,
          );
          return { error: 1 };
        }
      }
      case OnlyOfficeStatus.BEING_EDITED:
      case OnlyOfficeStatus.CLOSED_NO_CHANGES:
        // 无变化，直接成功
        return { error: 0 };
      case OnlyOfficeStatus.SAVE_CORRUPTED:
      case OnlyOfficeStatus.FORCE_SAVE_CORRUPTED:
        this.logger.error(`OnlyOffice 保存出错 docId=${id} status=${payload.status}`);
        return { error: 1 };
      default:
        this.logger.warn(`未识别的 OnlyOffice 状态：${payload.status}`);
        return { error: 0 };
    }
  }

  /**
   * 下载 OnlyOffice 返回的新文件，覆盖原文件并写版本快照
   * 流程：
   *  1. fetch payload.url → 覆盖 originalPath
   *  2. 写当前 content 快照（version=当前 version，若已存在则跳过）
   *  3. version+1，content_source='onlyoffice'
   *  4. 异步重抽纯文本索引（best-effort，失败仅日志）
   */
  private async applySavedFile(doc: Document, newFileUrl: string): Promise<void> {
    const absPath = path.join(getUploadDir(), doc.originalPath!);
    const buffer = await this.downloadFile(newFileUrl);
    await fs.writeFile(absPath, buffer);

    return this.entityManager.transaction(async (manager) => {
      const docRepo = manager.getRepository(Document);
      const versionRepo = manager.getRepository(DocumentVersion);

      // 写当前 content 快照（version=当前 version，已存在则跳过）
      const existing = await versionRepo.findOne({
        where: { documentId: doc.id, version: doc.version },
      });
      if (!existing) {
        await versionRepo.save(
          versionRepo.create({
            documentId: doc.id,
            version: doc.version,
            content: doc.content ?? '',
            snapshotPath: null,
          }),
        );
      }

      // 更新文档：version+1，标记来源为 onlyoffice
      await docRepo.update(doc.id, {
        version: doc.version + 1,
        contentSource: ContentSource.ONLYOFFICE,
        updatedAt: new Date(),
      });
    });

    // best-effort 重新抽取纯文本索引，失败不阻断保存
    this.refreshIndexText(doc.id).catch((err) => {
      this.logger.warn(
        `重新抽取索引文本失败 docId=${doc.id}：${(err as Error).message}`,
      );
    });
  }

  /**
   * 下载远程文件为 Buffer
   * OnlyOffice 回调 url 通常为 http://onlyoffice/cache/...，容器间内网访问
   */
  private async downloadFile(url: string): Promise<Buffer> {
    // Node 18+ 内置 fetch
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new InternalServerErrorException(
        `下载 OnlyOffice 保存文件失败：HTTP ${resp.status}`,
      );
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  /**
   * 重新抽取纯文本索引（best-effort）
   * 用 pandoc docx→plain 更新 content 字段，仅供搜索
   * pandoc 缺失或失败时跳过，不影响保存
   */
  private async refreshIndexText(docId: string): Promise<void> {
    const doc = await this.documentRepo.findOne({ where: { id: docId } });
    if (!doc || !doc.originalPath) return;
    const absPath = path.join(getUploadDir(), doc.originalPath);
    if (!existsSync(absPath)) return;
    const fromFormat = doc.format === DocumentFormat.DOCX ? 'docx' : 'odt';
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      execFile(
        'pandoc',
        ['-f', fromFormat, '-t', 'plain', absPath],
        { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            reject(err);
            return;
          }
          this.documentRepo
            .update(docId, { content: stdout || '' })
            .then(() => resolve())
            .catch(reject);
        },
      );
    });
  }

  /**
   * 校验回调 JWT
   * OnlyOffice 启用 JWT 时会把整个 payload 签名放到 token 字段
   * 校验失败抛 BadRequestException
   */
  private verifyCallbackToken(payload: OnlyOfficeCallbackPayload): void {
    if (!payload.token) {
      // OnlyOffice 未启用 JWT 或未签发，跳过校验（按部署策略可改为拒绝）
      return;
    }
    try {
      // 校验签名；载荷应与 payload 一致，此处仅验签不重新解析
      this.jwtService.verify(payload.token, {
        secret: onlyofficeConfig.jwtSecret,
      });
    } catch {
      throw new BadRequestException('OnlyOffice 回调 token 校验失败');
    }
  }
}

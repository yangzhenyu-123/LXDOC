import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { JwtService } from '@nestjs/jwt';
import { Document, DocumentFormat, ContentSource } from './document.entity';
import { DocumentVersion } from './document-version.entity';
import { AccessControlService } from '../organizations/access-control.service';
import { FilesService } from '../files/files.service';
import { getUploadDir } from '../config/upload.config';
import { onlyofficeConfig } from '../config/onlyoffice.config';
import { AuthUser } from '../common/decorators/current-user.decorator';

/**
 * OnlyOffice 可编辑格式按 documentType 分类
 * 来源：OnlyOffice Docs conversion-tables（⬤=可作输入编辑）
 * https://api.onlyoffice.com/docs/docs-api/additional-api/conversion-api/conversion-tables/
 *
 * - word：文档类（doc/docx/odt/rtf/txt/md/csv 等，含模板/宏/WPS/Apple/老格式）
 * - cell：表格类（xlsx/xls/ods/csv/tsv 等，含模板/宏/WPS/Apple/老格式）
 * - slide：演示类（pptx/ppt/odp/dps 等，含模板/宏/WPS/Apple/老格式）
 *
 * 注：csv/tsv 同时出现在 word 和 cell 表中，OnlyOffice 按 documentType 决定编辑器类型。
 *     这里归入 cell（表格更自然），与 conversion-tables 默认一致。
 *
 * 不纳入 OnlyOffice 编辑的格式（仍走 kkFileView 预览）：
 * - pdf：保持只读（docling 解析文本入库，避免 PDF→docx→编辑→回写破坏原版式）
 * - fodt/fods/fodp（flat XML）：可编辑但极少见，走预览即可
 * - epub/fb2/djvu/oxps/xps：电子书/版式，走预览
 * - heic 等图片/音视频/CAD/3D：附件专用，非文档
 */
const ONLYOFFICE_WORD_FORMATS = new Set<DocumentFormat>([
  DocumentFormat.DOC,
  DocumentFormat.DOCX,
  DocumentFormat.DOT,
  DocumentFormat.DOTM,
  DocumentFormat.DOTX,
  DocumentFormat.ODT,
  DocumentFormat.OTT,
  DocumentFormat.RTF,
  DocumentFormat.TXT,
  DocumentFormat.MD,
  DocumentFormat.WPS,
  DocumentFormat.WPT,
  DocumentFormat.OFD,
]);

const ONLYOFFICE_CELL_FORMATS = new Set<DocumentFormat>([
  DocumentFormat.XLS,
  DocumentFormat.XLSX,
  DocumentFormat.XLSM,
  DocumentFormat.XLT,
  DocumentFormat.XLTM,
  DocumentFormat.XLAM,
  DocumentFormat.ODS,
  DocumentFormat.OTS,
  DocumentFormat.FODS,
  DocumentFormat.ET,
  DocumentFormat.ETT,
  DocumentFormat.CSV,
  DocumentFormat.TSV,
]);

const ONLYOFFICE_SLIDE_FORMATS = new Set<DocumentFormat>([
  DocumentFormat.PPT,
  DocumentFormat.PPTX,
  DocumentFormat.PPTM,
  DocumentFormat.ODP,
  DocumentFormat.OTP,
  DocumentFormat.DPS,
]);

/**
 * 判断文档格式是否可由 OnlyOffice 编辑，并返回 documentType
 * 返回 null 表示该格式不走 OnlyOffice（应走 kkFileView 预览或 MarkdownEditor）
 */
function getOnlyOfficeDocumentType(
  format: DocumentFormat,
): 'word' | 'cell' | 'slide' | null {
  if (ONLYOFFICE_WORD_FORMATS.has(format)) return 'word';
  if (ONLYOFFICE_CELL_FORMATS.has(format)) return 'cell';
  if (ONLYOFFICE_SLIDE_FORMATS.has(format)) return 'slide';
  return null;
}

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
    private readonly dataSource: DataSource,
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
    const documentType = getOnlyOfficeDocumentType(doc.format);
    if (!documentType) {
      throw new BadRequestException(
        `OnlyOffice 不支持编辑 ${doc.format} 格式（该格式请用预览模式）`,
      );
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
      documentType,
      document: {
        fileType: doc.format,
        // key 随 version 变化，强制 OnlyOffice 重新加载。
        // 注意：key 会出现在 socket.io 连接 URL 路径中（/doc/<key>?EIO=4...），
        // 不能含 URL 保留字符（# ? & / 等），否则会被截断导致连接失败。
        // 用下划线连接 id 和 version，OnlyOffice 要求 key 仅含 [a-zA-Z0-9.-_]
        key: `${id}_v${doc.version}`,
        title: `${doc.title}.${doc.format}`,
        url: fileUrl,
        permissions: {
          edit: finalMode === 'edit',
          download: true,
          print: true,
          // review（修订模式）仅 word 类有意义，cell/slide 无此概念
          review: finalMode === 'edit' && documentType === 'word',
        },
      },
      editorConfig: {
        mode: finalMode,
        callbackUrl,
        lang: 'zh',
        user: { id: user.id, name: user.username || user.id },
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
   *
   * 安全：回调接口为 @Public，必须强制校验 JWT（OnlyOffice 用同一 jwtSecret 签 payload）。
   * 校验通过后再比对 token 内 payload 与传入 payload 关键字段（status/key/url）一致，
   * 防止合法 token 被复用到其他文档/状态。
   */
  async handleCallback(
    id: string,
    payload: OnlyOfficeCallbackPayload,
  ): Promise<{ error: 0 | 1 }> {
    // 强制校验回调 JWT：无 token 直接拒绝（回调接口为 @Public，不可跳过）
    try {
      this.verifyCallbackToken(payload, id);
    } catch (err) {
      this.logger.warn(
        `OnlyOffice 回调 token 校验失败 docId=${id}：${(err as Error).message}`,
      );
      return { error: 1 };
    }

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
   * S4 修复流程（文件覆盖移入事务后，保证一致性）：
   *  1. fetch payload.url → 写临时文件（暂存，不覆盖原文件）
   *  2. 事务内 SELECT FOR UPDATE 锁定文档行，写当前 content 快照，version+1
   *  3. 事务成功 → rename 临时文件覆盖原文件
   *  4. 事务失败 → 删除临时文件，原文件不受影响
   *  5. 异步重抽纯文本索引（best-effort，失败仅日志）
   *
   * 并发安全：用 SELECT FOR UPDATE 防止 forcesave 与关闭保存并发导致 version 冲突；
   * 文件用 tmp+rename 原子替换，避免写入中途崩溃损坏原文件。
   */
  private async applySavedFile(doc: Document, newFileUrl: string): Promise<void> {
    const absPath = path.join(getUploadDir(), doc.originalPath!);
    const buffer = await this.downloadFile(newFileUrl);
    // 暂存到临时文件（不覆盖原文件，等事务成功后再 rename）
    const tmpPath = `${absPath}.tmp-${Date.now()}`;
    await fs.writeFile(tmpPath, buffer);

    try {
      // 事务内加行锁，保证 version 递增的原子性
      await this.dataSource.transaction(async (manager) => {
        const docRepo = manager.getRepository(Document);
        const versionRepo = manager.getRepository(DocumentVersion);

        // SELECT ... FOR UPDATE 锁定当前文档行，读取最新 version
        const locked = await manager
          .getRepository(Document)
          .createQueryBuilder('d')
          .setLock('pessimistic_write')
          .where('d.id = :id', { id: doc.id })
          .getOne();
        if (!locked) {
          throw new NotFoundException(`文档 ${doc.id} 不存在`);
        }
        const currentVersion = locked.version;

        // 写当前 content 快照（version=当前 version，已存在则跳过）
        const existing = await versionRepo.findOne({
          where: { documentId: doc.id, version: currentVersion },
        });
        if (!existing) {
          await versionRepo.save(
            versionRepo.create({
              documentId: doc.id,
              version: currentVersion,
              content: doc.content ?? '',
              snapshotPath: null,
            }),
          );
        }

        // 更新文档：version+1，标记来源为 onlyoffice
        await docRepo.update(doc.id, {
          version: currentVersion + 1,
          contentSource: ContentSource.ONLYOFFICE,
          updatedAt: new Date(),
        });
      });

      // 事务成功后才覆盖原文件（原子 rename）
      await fs.rename(tmpPath, absPath);
    } catch (err) {
      // 事务失败：删除暂存文件，原文件不受影响
      await fs.unlink(tmpPath).catch(() => undefined);
      throw err;
    }

    // best-effort 重新抽取纯文本索引，失败不阻断保存
    this.refreshIndexText(doc.id).catch((err) => {
      this.logger.warn(
        `重新抽取索引文本失败 docId=${doc.id}：${(err as Error).message}`,
      );
    });
  }

  /**
   * 下载远程文件为 Buffer
   * 安全：
   * - URL 主机必须匹配 onlyofficeConfig.onlyofficeUrl 的 host（白名单），防止 SSRF
   * - 30s 超时，防止挂起
   */
  private async downloadFile(url: string): Promise<Buffer> {
    // 校验 url 主机在 OnlyOffice 白名单内
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('OnlyOffice 回调 url 格式非法');
    }
    const allowedHosts = this.resolveAllowedHosts();
    if (!allowedHosts.has(parsed.hostname)) {
      throw new ForbiddenException(
        `OnlyOffice 回调 url 主机不在白名单：${parsed.hostname}`,
      );
    }
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      throw new InternalServerErrorException(
        `下载 OnlyOffice 保存文件失败：HTTP ${resp.status}`,
      );
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  /**
   * 解析允许下载的 host 集合：onlyofficeUrl 的 host + 回环
   */
  private resolveAllowedHosts(): Set<string> {
    const hosts = new Set<string>();
    try {
      hosts.add(new URL(onlyofficeConfig.onlyofficeUrl).hostname);
    } catch {
      // ignore
    }
    // 允许 OnlyOffice 通过 127.0.0.1/localhost 回调（部分部署形态）
    hosts.add('127.0.0.1');
    hosts.add('localhost');
    return hosts;
  }

   /**
    * 重新抽取纯文本索引（best-effort）
    * 按 format 分流文本抽取策略：
    * - pandoc 可处理：doc/docx/dot/dotm/dotx/odt/ott/rtf/wps/wpt/ofd → pandoc → plain
    * - 直接读 utf-8：md/txt/csv/tsv（纯文本无需重型解析）
    * - pdf：跳过（docling 已在 upload 时解析，编辑不改变原 PDF）
    * - cell/slide 类（xlsx/xls/ods/et/pptx/ppt/odp/dps 等）：跳过（索引文本非必须，
    *   且 pandoc 不支持这些格式；全文搜索仍可通过标题/标签覆盖）
    *
    * pandoc 缺失或失败时跳过，不影响保存。
    */
  private async refreshIndexText(docId: string): Promise<void> {
    const doc = await this.documentRepo.findOne({ where: { id: docId } });
    if (!doc || !doc.originalPath) return;
    const absPath = path.join(getUploadDir(), doc.originalPath);
    if (!existsSync(absPath)) return;

    // 纯文本类：直接读 utf-8
    const PLAIN_TEXT_FORMATS = new Set<DocumentFormat>([
      DocumentFormat.MD,
      DocumentFormat.TXT,
      DocumentFormat.CSV,
      DocumentFormat.TSV,
    ]);
    if (PLAIN_TEXT_FORMATS.has(doc.format)) {
      try {
        const text = await fs.readFile(absPath, 'utf-8');
        await this.documentRepo.update(docId, { content: text });
      } catch (err) {
        this.logger.warn(
          `读取纯文本索引失败 docId=${docId}：${(err as Error).message}`,
        );
      }
      return;
    }

    // pandoc 可处理的 word 类格式
    const PANDOC_FORMATS = new Set<DocumentFormat>([
      DocumentFormat.DOC,
      DocumentFormat.DOCX,
      DocumentFormat.DOT,
      DocumentFormat.DOTM,
      DocumentFormat.DOTX,
      DocumentFormat.ODT,
      DocumentFormat.OTT,
      DocumentFormat.RTF,
      DocumentFormat.WPS,
      DocumentFormat.WPT,
      DocumentFormat.OFD,
    ]);
    if (!PANDOC_FORMATS.has(doc.format)) {
      // cell/slide/pdf 等：跳过索引抽取（best-effort）
      return;
    }

    // pandoc 输入格式名（与 DocumentFormat 值基本一致，少数需映射）
    const pandocFromMap: Partial<Record<DocumentFormat, string>> = {
      [DocumentFormat.DOC]: 'doc',
      [DocumentFormat.DOCX]: 'docx',
      [DocumentFormat.DOT]: 'doc',
      [DocumentFormat.DOTM]: 'docx',
      [DocumentFormat.DOTX]: 'docx',
      [DocumentFormat.ODT]: 'odt',
      [DocumentFormat.OTT]: 'odt',
      [DocumentFormat.RTF]: 'rtf',
      [DocumentFormat.WPS]: 'docx',
      [DocumentFormat.WPT]: 'docx',
      [DocumentFormat.OFD]: 'ofd',
    };
    const fromFormat = pandocFromMap[doc.format] ?? doc.format;
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
    }).catch((err) => {
      this.logger.warn(
        `pandoc 抽取索引文本失败 docId=${docId}：${(err as Error).message}`,
      );
    });
  }

  /**
   * 校验回调 JWT
   * OnlyOffice 启用 JWT 时会把整个 payload 签名放到 token 字段。
   * 安全要求：
   * - token 必须存在且签名有效（回调接口为 @Public，不允许跳过）
   * - 解码后比对 status/key/url 与传入 payload 一致，防止 token 复用
   * - H1 修复：校验 payload.key 中的 docId 与 URL id 匹配，防止跨文档重放覆盖
   * 校验失败抛 BadRequestException
   */
  private verifyCallbackToken(payload: OnlyOfficeCallbackPayload, docId: string): void {
    if (!payload.token) {
      throw new BadRequestException('OnlyOffice 回调缺少 token');
    }
    let decoded: any;
    try {
      decoded = this.jwtService.verify(payload.token, {
        secret: onlyofficeConfig.jwtSecret,
      });
    } catch {
      throw new BadRequestException('OnlyOffice 回调 token 校验失败');
    }
    // 比对关键字段，防止合法 token 被复用到其他文档/状态
    if (
      decoded?.status !== payload.status ||
      decoded?.key !== payload.key ||
      (payload.url !== undefined && decoded?.url !== payload.url)
    ) {
      throw new BadRequestException('OnlyOffice 回调 payload 与 token 不一致');
    }
    // H1 修复：校验 key 中的 docId 与 URL id 匹配（key 格式为 `${id}_v${version}`）
    if (!payload.key || !payload.key.startsWith(`${docId}_v`)) {
      throw new BadRequestException('OnlyOffice 回调 key 与文档 ID 不匹配');
    }
  }
}

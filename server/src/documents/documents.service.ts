import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Document, DocumentFormat, DocumentOwnerType, ContentSource } from './document.entity';
import { DocumentVersion } from './document-version.entity';
import { DocumentFavorite } from './document-favorite.entity';
import { Category } from '../categories/category.entity';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { getUploadDir } from '../config/upload.config';
import { AccessControlService } from '../organizations/access-control.service';
import { FilesService } from '../files/files.service';
import { PdfToolsService } from './pdf-tools.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { OptionalLlm } from '../llm/optional-llm.decorator';
import { LlmService } from '../llm/llm.service';
import { LlmConfigService } from '../llm/llm-config.service';
import { llmConfig } from '../config/llm.config';
import { kkfileviewConfig } from '../config/kkfileview.config';
import { onlyofficeConfig } from '../config/onlyoffice.config';

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
  createdByName?: string | null;
  ownerType: string;
  ownerId: string | null;
  favorited?: boolean;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(DocumentVersion)
    private readonly versionRepo: Repository<DocumentVersion>,
    @InjectRepository(DocumentFavorite)
    private readonly favoriteRepo: Repository<DocumentFavorite>,
    private readonly entityManager: EntityManager,
    private readonly accessControl: AccessControlService,
    private readonly filesService: FilesService,
    private readonly pdfTools: PdfToolsService,
    private readonly llmConfigService: LlmConfigService,
    // LLM 可选注入：LlmModule 已导入时拿到 LlmService，未启用时为 undefined
    @OptionalLlm() private readonly llm?: LlmService,
  ) {}

  /**
   * 获取单个文档（含 content）
   * @param user 若提供则校验读权限
   */
  async findOne(id: string, user?: AuthUser): Promise<Document> {
    const doc = await this.documentRepo.findOne({ where: { id } });
    if (!doc) {
      throw new NotFoundException(`文档 ${id} 不存在`);
    }
    if (user) {
      this.accessControl.assertCanRead(user, doc);
    }
    return doc;
  }

  /**
   * 获取 docx / odt 文档的 HTML 预览片段
   * 1. 校验文档存在、格式为 docx/odt、原文件存在
   * 2. 调用 pandoc 转 HTML（不加 standalone，输出即 body 片段）
   * 3. 签发短期文件 token（读权限已在 findOne 中校验）
   * 4. 把图片相对路径替换为签名 URL /api/files/<docId>/image/<name>?token=
   * 5. 返回 HTML 字符串
   */
  async getPreviewHtml(id: string, user: AuthUser): Promise<string> {
    const doc = await this.findOne(id, user);

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
    // 创建临时目录供 pandoc --extract-media 提取图片（ODT 的 Pictures/、DOCX 的 word/media/）
    // 转换后需把图片复制到持久化目录 uploads/images/<docId>/，供 /api/files/:docId/image/:name 加载
    const tmpMediaDir = await fs.mkdtemp(
      path.join(getUploadDir(), 'cache', 'pandoc-media-'),
    );
    try {
      html = await this.runPandocToHtml(fromFormat, absPath, tmpMediaDir);
      // 将提取的图片扁平化复制到 uploads/images/<docId>/（去掉 Pictures/ 等中间目录层，
      // 使 /api/files/:docId/image/:name 路由能直接匹配纯文件名）
      const imagesDir = path.join(getUploadDir(), 'images', id);
      await fs.mkdir(imagesDir, { recursive: true });
      await this.copyMediaFiles(tmpMediaDir, imagesDir);
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
    } finally {
      // 清理临时提取目录
      await fs.rm(tmpMediaDir, { recursive: true, force: true }).catch(() => {});
    }

    // 签发短期文件 token（读权限已在 findOne 中断言通过）
    const fileToken = this.filesService.signFileToken(id, user.id);

    // 改写图片 src：pandoc --extract-media 输出绝对路径 <tmpdir>/Pictures/xxx.png 或 <tmpdir>/media/xxx.png，
    // 匹配 media|images|Pictures 前缀路径，取 basename 作为文件名，改写为鉴权 URL
    // （同时兼容不加 --extract-media 时的相对路径 media/xxx.png、images/xxx.png）
    html = html.replace(
      /src=["'](?:[^"']*[\/\\])?(?:media|images|Pictures)[\/\\]([^"']+)["']/g,
      (_match, name: string) => {
        const filename = path.basename(name);
        return `src="/api/files/${id}/image/${encodeURIComponent(filename)}?token=${fileToken}"`;
      },
    );

    return html;
  }

  /**
   * 获取 PDF 文档的版式保真 HTML（pdf2htmlEX 生成，带缓存）
   * 读权限已在 findOne 中校验
   */
  async getPdfHtml(id: string, user: AuthUser): Promise<string> {
    const doc = await this.findOne(id, user);
    if (doc.format !== DocumentFormat.PDF) {
      throw new BadRequestException('仅支持 PDF 版式预览');
    }
    if (!doc.originalPath) {
      throw new NotFoundException(`文档 ${id} 缺少原始文件`);
    }
    const absPath = path.join(getUploadDir(), doc.originalPath);
    if (!existsSync(absPath)) {
      throw new NotFoundException(`原始文件不存在：${doc.originalPath}`);
    }
    try {
      return await this.pdfTools.generateLayoutHtml(absPath, id, doc.version);
    } catch (err) {
      throw new InternalServerErrorException(
        `PDF 版式预览生成失败：${(err as Error).message}`,
      );
    }
  }

  /**
   * 构建 kkFileView 统一预览 URL
   * kkFileView 通过 ?url=<base64编码的文件下载URL> 拉取原文件并渲染
   * 文件下载走鉴权签名接口 /api/files/:docId/original?token=（kkFileView 容器需能访问后端）
   * 返回前端可直接 iframe 嵌入的浏览器可访问 URL（publicUrl）
   *
   * 适用：docx/odt/pdf 及其它 kkFileView 支持的格式，作为保真预览的统一入口
   * kkFileView 未启用时抛 503，前端回退 pandoc/pdf2htmlEX
   */
  async getKkViewUrl(id: string, user: AuthUser): Promise<string> {
    if (!kkfileviewConfig.enabled) {
      throw new ServiceUnavailableException(
        'kkFileView 预览未启用，请联系管理员配置 KKFILEVIEW_ENABLED=true',
      );
    }
    const doc = await this.findOne(id, user);
    if (!doc.originalPath) {
      throw new NotFoundException(`文档 ${id} 缺少原始文件`);
    }
    const absPath = path.join(getUploadDir(), doc.originalPath);
    if (!existsSync(absPath)) {
      throw new NotFoundException(`原始文件不存在：${doc.originalPath}`);
    }
    // 签发短期文件 token（读权限已在 findOne 中校验）
    const fileToken = this.filesService.signFileToken(id, user.id);
    // kkFileView 容器通过 backendPublicUrl 拉取文件（与 OnlyOffice 回调同一地址）
    const fileDownloadUrl = `${onlyofficeConfig.backendPublicUrl}/api/files/${id}/original?token=${encodeURIComponent(fileToken)}`;
    // kkFileView 5.1.0 从 URL 路径推断文件后缀，但 /api/files/:id/original 路径无文件名，
    // 需附 fullfilename 参数让 kkfileview 据此判断类型，否则 StringIndexOutOfBoundsException
    // 文件名用 doc.title + 扩展名（仅用于类型识别，不影响实际下载内容）
    const safeTitle = (doc.title ?? 'document').replace(/[\\/:*?"<>|]/g, '_');
    const fullFileName = `${safeTitle}.${doc.format}`;
    const fileUrlWithHint = `${fileDownloadUrl}&fullfilename=${encodeURIComponent(fullFileName)}`;
    // kkFileView 约定 ?url= 参数为 base64 编码的文件 URL
    const encoded = Buffer.from(fileUrlWithHint).toString('base64');
    return `${kkfileviewConfig.publicUrl}/onlinePreview?url=${encodeURIComponent(encoded)}`;
  }

  /**
   * 将 PDF 转为可编辑的新 markdown 文档（原 PDF 保留不动）
   * 流程：soffice PDF→docx → pandoc docx→markdown → 新建 Document(format=md)
   * 权限：需对原文档有写权限
   * 新文档继承原文档的 categoryId / ownerType / ownerId，title 加"(可编辑)"后缀
   */
  async convertToEditable(id: string, user: AuthUser): Promise<Document> {
    const doc = await this.findOne(id);
    await this.accessControl.assertCanWrite(user, doc);
    if (doc.format !== DocumentFormat.PDF) {
      throw new BadRequestException('仅支持 PDF 转可编辑');
    }
    if (!doc.originalPath) {
      throw new NotFoundException(`文档 ${id} 缺少原始文件`);
    }
    const absPath = path.join(getUploadDir(), doc.originalPath);
    if (!existsSync(absPath)) {
      throw new NotFoundException(`原始文件不存在：${doc.originalPath}`);
    }

    let markdown: string;
    try {
      markdown = await this.pdfTools.convertPdfToMarkdown(absPath, id);
    } catch (err) {
      throw new InternalServerErrorException(
        `PDF 转可编辑失败：${(err as Error).message}`,
      );
    }

    // 事务内创建文档与初始版本快照，保证一致性
    return this.entityManager.transaction(async (manager) => {
      const docRepo = manager.getRepository(Document);
      const versionRepo = manager.getRepository(DocumentVersion);

      // 新建 markdown 文档，继承归属与分类
      const newDoc = docRepo.create({
        categoryId: doc.categoryId,
        title: `${doc.title}(可编辑)`,
        content: markdown,
        format: DocumentFormat.MD,
        originalPath: null,
        version: 1,
        author: doc.author,
        tags: [...(doc.tags ?? [])],
        createdBy: user.id,
        ownerType: doc.ownerType,
        ownerId:
          doc.ownerType === DocumentOwnerType.PERSONAL ? user.id : doc.ownerId,
        contentSource: ContentSource.MANUAL,
      });
      const saved = await docRepo.save(newDoc);
      // 创建 version=1 初始快照
      await versionRepo.save(
        versionRepo.create({
          documentId: saved.id,
          version: 1,
          content: markdown,
          snapshotPath: null,
        }),
      );
      return saved;
    });
  }

  /**
   * AI 总结：基于原文档已解析的文本，调用 GLM5.2 生成结构化 Markdown 总结文档
   *
   * 工作流（存档+总结）：原文档保留不动 → 投喂文本给 LLM → 生成新 Markdown 文档（Docsify 风格渲染）
   *
   * 设计要点：
   * - 无向量模型：纯文本投喂，不做 RAG 检索；文本过长按 summaryMaxChars 截断（保留头尾）
   * - 权限：对原文档有读权限即可触发（生成的是新文档，不修改原文档）
   * - 新文档继承原文档 categoryId/ownerType/ownerId，归属同一空间，确保可见范围一致
   * - sourceDocId 反向指向原文档，contentSource=AI_SUMMARY 标记为 AI 生成
   * - LLM 未启用/未就绪：抛 ServiceUnavailableException（用户主动触发的功能，需明确报错而非静默降级）
   * - title 加「- AI总结」后缀，tags 追加 'ai-summary' 便于检索筛选
   *
   * @return 新创建的总结文档（format=md, contentSource=ai_summary）
   */
  async summarize(id: string, user: AuthUser): Promise<Document> {
    const doc = await this.findOne(id, user);

    // 解析当前用户生效的 LLM 配置：
    // - 普通用户：返回自己配的；未配则 null（系统不提供默认）
    // - admin：优先自己配的 → 回退系统配置 llm.*；都没有则 null
    const userLlm = await this.llmConfigService.resolveForUser(user.id);

    // 新架构：resolveForUser 返回 null 表示无任何可用配置（含 admin 系统配置也未配），
    // 直接报错，不再回退全局 .env（普通用户不提供默认 API）
    if (!userLlm) {
      throw new ServiceUnavailableException(
        'AI 总结不可用：未配置 LLM。普通用户请在「个人设置」配置自己的 LLM；管理员请在「个人设置」或「系统配置」中配置。',
      );
    }

    // 读取已解析的文本内容
    // 图片链接替换为占位：LLM 无法识图，保留 /api/files/... URL 对模型是无意义噪声，
    // 替换为 [图片: alt] 占位，既减少 token 又保留图片存在感知
    const rawText = (doc.content ?? '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) =>
        `[图片${alt ? `: ${alt}` : ''}]`,
      )
      .trim();
    if (!rawText) {
      throw new BadRequestException(
        '文档无可用文本内容（可能尚未解析或为空文档），无法生成总结',
      );
    }

    // 截断过长文本，避免超出模型上下文窗口；保留头尾以兼顾开头与结尾信息
    const feedText = this.truncateForSummary(rawText);

    // 构造总结 prompt：要求生成结构化 Markdown，适合 Docsify 阅读视图
    const summaryPrompt = this.buildSummaryPrompt(doc.title, feedText);

    const result = await this.llm.chat(summaryPrompt.messages, {
      temperature: 0.3, // 总结任务用较低温度保证稳定
      maxTokens: summaryPrompt.maxTokens,
      timeout: Math.max(llmConfig.timeout, 120_000), // 总结耗时较长，给 2 分钟
      // 传入用户选择的 LLM 配置覆盖（未选时为 undefined，回退全局）
      ...(userLlm ?? {}),
    });

    if (!result || !result.content?.trim()) {
      throw new ServiceUnavailableException(
        'AI 总结生成失败：模型返回为空，请稍后重试或检查 LLM 服务状态',
      );
    }

    const summaryMarkdown = result.content.trim();

    // 独立调用 LLM 生成知识库分类路径（与总结分开，便于解析且不污染总结输出）
    // 路径用于前端 AI 知识库树形导航，按文档主题归类
    const knowledgePath = await this.generateKnowledgePath(
      doc.title,
      feedText,
      userLlm,
    );

    // 事务内创建总结文档与初始版本快照
    return this.entityManager.transaction(async (manager) => {
      const docRepo = manager.getRepository(Document);
      const versionRepo = manager.getRepository(DocumentVersion);

      const newDoc = docRepo.create({
        categoryId: doc.categoryId,
        title: `${doc.title} - AI总结`,
        content: summaryMarkdown,
        format: DocumentFormat.MD,
        originalPath: null,
        version: 1,
        author: doc.author,
        tags: [...(doc.tags ?? []), 'ai-summary'],
        createdBy: user.id,
        ownerType: doc.ownerType,
        ownerId:
          doc.ownerType === DocumentOwnerType.PERSONAL ? user.id : doc.ownerId,
        contentSource: ContentSource.AI_SUMMARY,
        sourceDocId: doc.id,
        knowledgePath,
      });
      const saved = await docRepo.save(newDoc);
      await versionRepo.save(
        versionRepo.create({
          documentId: saved.id,
          version: 1,
          content: summaryMarkdown,
          snapshotPath: null,
        }),
      );
      this.logger.log(
        `AI 总结生成成功 source=${doc.id} summary=${saved.id} ` +
          `promptTokens=${result.promptTokens ?? '-'} completionTokens=${result.completionTokens ?? '-'}`,
      );
      return saved;
    });
  }

  /**
   * 截断过长文本以适配模型上下文窗口
   * 保留前半 + 后半（各半），中间以省略标记连接，兼顾开头摘要与结尾结论
   */
  private truncateForSummary(text: string): string {
    const max = llmConfig.summaryMaxChars;
    if (text.length <= max) {
      return text;
    }
    const half = Math.floor(max / 2);
    const head = text.slice(0, half);
    const tail = text.slice(text.length - half);
    return `${head}\n\n…（中间内容已省略，原文共 ${text.length} 字符）…\n\n${tail}`;
  }

  /**
   * 构造总结 prompt
   * - system：设定角色与输出格式约束（结构化 Markdown，适合 Docsify 渲染）
   * - user：文档标题 + 截断后的正文
   * 返回 messages 与建议 maxTokens
   */
  private buildSummaryPrompt(
    title: string,
    feedText: string,
  ): { messages: { role: 'system' | 'user'; content: string }[]; maxTokens: number } {
    const system = [
      '你是一名专业的文档分析师，擅长将冗长的文档提炼为结构清晰的中文总结。',
      '请基于用户提供的文档内容，生成一份结构化 Markdown 总结文档，要求：',
      '1. 使用 Markdown 标题层级（# 一级标题为文档总结标题，## 二级标题分节）',
      '2. 开头用一段「概述」概括文档主旨（2-4 句）',
      '3. 提炼「核心要点」用无序列表呈现，每条简洁明了',
      '4. 若文档含关键数据/结论/日期，单列「关键信息」小节',
      '5. 末尾给出「适用场景」或「后续建议」（1-2 条）',
      '6. 只输出 Markdown 正文，不要包裹在代码块中，不要输出与总结无关的寒暄',
      '7. 忠于原文，不得编造未提及的信息',
    ].join('\n');
    const userContent = `文档标题：${title}\n\n文档内容：\n${feedText}`;
    return {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      // 总结输出上限 4096 tokens，足够一份结构化总结
      maxTokens: 4096,
    };
  }

  /**
   * 调用 LLM 生成知识库分类路径
   * 基于文档标题与内容，让模型输出一个层级路径（如 "技术文档/操作系统/Linux"）
   * 用于前端 AI 知识库树形导航。失败时回退到"未分类"，不阻断总结流程。
   */
  private async generateKnowledgePath(
    title: string,
    feedText: string,
    userLlm?: { baseUrl: string; apiKey: string; model: string; enableThinking: boolean } | null,
  ): Promise<string> {
    // 新架构：userLlm 为 null 表示无可用配置（含全局也未配），直接回退"未分类"
    if (!userLlm) return '未分类';
    try {
      const system = [
        '你是一名文档分类专家。请根据用户提供的文档标题与内容，',
        '为其生成一个简洁的中文分类路径，用于知识库树形导航。',
        '要求：',
        '1. 路径用 / 分隔，2-4 级，每级 2-6 个汉字或英文词',
        '2. 第一级从这些主题中选择：技术文档、解决方案、Bug分析、产品文档、培训资料、项目管理',
        '3. 后续级别按文档具体主题细分',
        '4. 只输出路径本身，不要引号、不要解释、不要换行',
        '示例输出：技术文档/操作系统/Linux',
      ].join('\n');
      const userContent = `文档标题：${title}\n\n内容摘要（前 1500 字符）：\n${feedText.slice(0, 1500)}`;
      const result = await this.llm.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        {
          temperature: 0.1,
          maxTokens: 128,
          timeout: 30_000,
          // 路径生成是简单分类任务，关闭推理直接输出，省 token 且快
          enableThinking: userLlm?.enableThinking ?? false,
          // 传入用户选择的 LLM 配置覆盖
          ...(userLlm ? { baseUrl: userLlm.baseUrl, apiKey: userLlm.apiKey, model: userLlm.model } : {}),
        },
      );
      const path = (result?.content ?? '').trim();
      // 清理：取第一行（LLM 可能输出路径后跟解释），去引号/换行
      const firstLine = path.split(/\r?\n/)[0] ?? '';
      const cleaned = firstLine.replace(/["'`]/g, '').trim();
      if (!cleaned) return '未分类';
      // 截断过长输出（防止 LLM 输出整段解释），保留前 200 字符
      const truncated = cleaned.slice(0, 200);
      // 确保每段非空
      const segs = truncated.split('/').map((s) => s.trim()).filter(Boolean);
      if (segs.length === 0) return '未分类';
      return segs.join('/');
    } catch (err) {
      this.logger.warn(
        `生成知识库路径失败，回退到"未分类"：${(err as Error).message}`,
      );
      return '未分类';
    }
  }

  /**
   * 调用 pandoc 将文档转换为 HTML 片段（不带 standalone）
   * 用 execFile 包装 Promise，超时 60s
   * pandoc 未安装时抛 InternalServerErrorException('Pandoc 未安装')
   *
   * @param fromFormat 源格式（docx / odt）
   * @param filePath 源文件绝对路径
   * @param mediaDir 可选，传入则添加 --extract-media=<mediaDir>，
   *   pandoc 会把文档内嵌图片提取到该目录（ODT 的 Pictures/、DOCX 的 word/media/）
   */
  private runPandocToHtml(
    fromFormat: string,
    filePath: string,
    mediaDir?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-f', fromFormat, '-t', 'html', filePath];
      if (mediaDir) {
        args.push(`--extract-media=${mediaDir}`);
      }
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
          resolve(stdout);
        },
      );
    });
  }

  /**
   * 递归复制 pandoc --extract-media 提取的图片文件到目标目录（扁平化，去掉子目录层）
   * 例：srcDir/Pictures/xxx.png → destDir/xxx.png
   * 同名文件后者覆盖前者（不同 ODT 的 Pictures/ 文件名唯一，冲突概率极低）
   */
  private async copyMediaFiles(srcDir: string, destDir: string): Promise<void> {
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      if (entry.isDirectory()) {
        // 子目录递归，但文件直接放 destDir（扁平化）
        await this.copyMediaFiles(srcPath, destDir);
      } else {
        await fs.copyFile(srcPath, path.join(destDir, entry.name));
      }
    }
  }

  /**
   * 更新文档（事务）
   * 1. 写入当前内容的版本快照（version=当前 version，若已存在则跳过）
   * 2. 更新 Document 的 title/content/tags（若提供），version + 1
   * 权限：admin 全权；editor 仅能改自己 createdBy 的文档；其他拒绝
   *
   * 并发安全：事务内 SELECT FOR UPDATE 锁定文档行后读取最新 version，
   * 避免两个并发 PUT 都读到旧 version 导致后者覆盖前者且 version 不递增。
   */
  async update(
    id: string,
    dto: UpdateDocumentDto,
    currentUser: AuthUser,
  ): Promise<Document> {
    const doc = await this.findOne(id);
    await this.accessControl.assertCanWrite(currentUser, doc);

    return this.entityManager.transaction(async (manager) => {
      const docRepo = manager.getRepository(Document);
      const versionRepo = manager.getRepository(DocumentVersion);

      // 锁定文档行，读取最新 version（防止并发覆盖）
      const locked = await manager
        .getRepository(Document)
        .createQueryBuilder('d')
        .setLock('pessimistic_write')
        .where('d.id = :id', { id })
        .getOne();
      if (!locked) {
        throw new NotFoundException(`文档 ${id} 不存在`);
      }
      const currentVersion = locked.version;

      // 1. 写入当前内容快照（version=当前 version）
      // 若该版本已存在（例如从未修改过、version=1 的初始快照），则跳过
      const existing = await versionRepo.findOne({
        where: { documentId: id, version: currentVersion },
      });
      if (!existing) {
        await versionRepo.save(
          versionRepo.create({
            documentId: id,
            version: currentVersion,
            content: locked.content ?? '',
            snapshotPath: null,
          }),
        );
      }

      // 2. 更新 Document（基于锁定行读取的最新 version 递增）
      const patch: Partial<Document> = {
        version: currentVersion + 1,
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
  async listVersions(id: string, user: AuthUser): Promise<DocumentVersionListItem[]> {
    // 校验文档存在 + 读权限
    await this.findOne(id, user);
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
    user: AuthUser,
  ): Promise<DocumentVersionContent> {
    // 校验文档存在 + 读权限
    await this.findOne(id, user);
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
   *
   * 并发安全：事务内 SELECT FOR UPDATE 锁定文档行，读取最新 version 后递增。
   */
  async rollback(
    id: string,
    version: number,
    currentUser: AuthUser,
  ): Promise<Document> {
    const doc = await this.findOne(id);
    await this.accessControl.assertCanWrite(currentUser, doc);
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

      // 锁定文档行，读取最新 version（防止并发回滚覆盖）
      const locked = await manager
        .getRepository(Document)
        .createQueryBuilder('d')
        .setLock('pessimistic_write')
        .where('d.id = :id', { id })
        .getOne();
      if (!locked) {
        throw new NotFoundException(`文档 ${id} 不存在`);
      }
      const currentVersion = locked.version;

      // 写入当前内容快照
      const existing = await versionRepo.findOne({
        where: { documentId: id, version: currentVersion },
      });
      if (!existing) {
        await versionRepo.save(
          versionRepo.create({
            documentId: id,
            version: currentVersion,
            content: locked.content ?? '',
            snapshotPath: null,
          }),
        );
      }

      // 更新 Document.content 为目标版本内容，version + 1
      await docRepo.update(id, {
        content: target.content,
        version: currentVersion + 1,
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
    currentUser: AuthUser,
  ): Promise<void> {
    const doc = await this.findOne(id);
    await this.accessControl.assertCanWrite(currentUser, doc);

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
   * 清理文档对应的磁盘文件：original/<docId>/、images/<docId>/、cache/<docId>/
   * 文件缺失不视为错误（rm recursive + force）
   * cache 目录存放 pdf2htmlEX 生成的版式 HTML 与转可编辑的中间产物，需一并清理避免孤儿缓存
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
    // 删除 cache/<docId>/ 目录（pdf2htmlEX 版式 HTML 缓存 + 转可编辑中间产物）
    const cacheDir = path.join(uploadDir, 'cache', docId);
    await fs.rm(cacheDir, { recursive: true, force: true });
    // originalPath 为空时无需额外处理（已被目录删除覆盖）
    void originalPath;
  }

  /**
   * 列出最近更新的 N 篇文档（按 updatedAt DESC），不含 content
   * limit 上限 50，避免一次拉取过多
   * 按当前用户读权限过滤可见范围
   */
  async findRecent(limit: number, user: AuthUser): Promise<DocumentListItem[]> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : 10;
    const qb = this.documentRepo
      .createQueryBuilder('d')
      .select([
        'd.id',
        'd.title',
        'd.format',
        'd.version',
        'd.tags',
        'd.updatedAt',
        'd.createdBy',
        'd.ownerType',
        'd.ownerId',
      ])
      .orderBy('d.updatedAt', 'DESC')
      .limit(safeLimit);
    this.accessControl.applyReadScopeToQb(qb, user);
    const docs = await qb.getMany();

    return docs.map((d) => ({
      id: d.id,
      title: d.title,
      format: d.format,
      version: d.version,
      tags: d.tags ?? [],
      updatedAt: d.updatedAt,
      createdBy: d.createdBy,
      ownerType: d.ownerType,
      ownerId: d.ownerId,
    }));
  }

  /**
   * 列出所有 AI 总结文档（contentSource=ai_summary），返回扁平列表含 knowledgePath
   * 前端按 knowledgePath 构建知识库树形导航。按 updatedAt DESC 排序。
   * 按当前用户读权限过滤可见范围。
   */
  async findKnowledgeTree(user: AuthUser): Promise<
    {
      id: string;
      title: string;
      knowledgePath: string;
      format: string;
      updatedAt: Date;
    }[]
  > {
    const qb = this.documentRepo
      .createQueryBuilder('d')
      .select([
        'd.id',
        'd.title',
        'd.knowledgePath',
        'd.format',
        'd.updatedAt',
      ])
      .where('d.content_source = :src', { src: ContentSource.AI_SUMMARY })
      .orderBy('d.updatedAt', 'DESC');
    this.accessControl.applyReadScopeToQb(qb, user);
    const docs = await qb.getMany();
    return docs.map((d) => ({
      id: d.id,
      title: d.title,
      knowledgePath: d.knowledgePath ?? '未分类',
      format: d.format,
      updatedAt: d.updatedAt,
    }));
  }

  /**
   * 列出某分类下的所有文档（不含 content）
   * 若 includeChildren=true，递归包含所有子分类下的文档
   * 按当前用户读权限过滤可见范围
   */
  async listByCategory(
    categoryId: string,
    user: AuthUser,
    includeChildren = false,
  ): Promise<DocumentListItem[]> {
    let categoryIds: string[] = [categoryId];

    if (includeChildren) {
      // 服务层递归查询所有子孙分类 id
      categoryIds = await this.collectDescendantCategoryIds(categoryId);
    }

    // 防御：空数组时 TypeORM IN() 会生成非法 SQL，直接返回空
    if (categoryIds.length === 0) {
      return [];
    }

    const qb = this.documentRepo
      .createQueryBuilder('d')
      .select([
        'd.id',
        'd.title',
        'd.format',
        'd.version',
        'd.tags',
        'd.updatedAt',
        'd.createdBy',
        'd.ownerType',
        'd.ownerId',
      ])
      .where('d.category_id IN (:...ids)', { ids: categoryIds })
      .orderBy('d.updatedAt', 'DESC');
    this.accessControl.applyReadScopeToQb(qb, user);
    const docs = await qb.getMany();

    return docs.map((d) => ({
      id: d.id,
      title: d.title,
      format: d.format,
      version: d.version,
      tags: d.tags ?? [],
      updatedAt: d.updatedAt,
      createdBy: d.createdBy,
      ownerType: d.ownerType,
      ownerId: d.ownerId,
    }));
  }

  /**
   * 收集某分类的所有子孙分类 id（包含自身）
   * 一次性拉取全部分类后在内存构建树，避免逐层 N+1 查询。
   */
  private async collectDescendantCategoryIds(
    rootId: string,
  ): Promise<string[]> {
    const categoryRepo = this.entityManager.getRepository(Category);
    // 一次查询拉全表（分类通常不大），在内存中遍历
    const all = await categoryRepo.find({ select: ['id', 'parentId'] });
    const childrenMap = new Map<string, string[]>();
    for (const c of all) {
      if (c.parentId) {
        const arr = childrenMap.get(c.parentId);
        if (arr) arr.push(c.id);
        else childrenMap.set(c.parentId, [c.id]);
      }
    }
    const result: string[] = [rootId];
    const queue: string[] = [rootId];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = childrenMap.get(currentId);
      if (children) {
        for (const childId of children) {
          result.push(childId);
          queue.push(childId);
        }
      }
    }
    return result;
  }

  // ============================================================
  // 收藏 / 快捷入口 / 标签聚合（方案 A 增量增强）
  // ============================================================

  /**
   * 切换收藏状态（已收藏则取消，未收藏则添加）
   * 不校验文档存在性（外键约束兜底），重复收藏由唯一约束兜底
   */
  async toggleFavorite(
    docId: string,
    user: AuthUser,
  ): Promise<{ favorited: boolean }> {
    const existing = await this.favoriteRepo.findOne({
      where: { userId: user.id, documentId: docId },
    });
    if (existing) {
      await this.favoriteRepo.remove(existing);
      return { favorited: false };
    }
    await this.favoriteRepo.save(
      this.favoriteRepo.create({ userId: user.id, documentId: docId }),
    );
    return { favorited: true };
  }

  /**
   * 查询某用户是否收藏了某文档（供文档详情页显示星标状态）
   */
  async isFavorited(docId: string, user: AuthUser): Promise<boolean> {
    const existing = await this.favoriteRepo.findOne({
      where: { userId: user.id, documentId: docId },
    });
    return !!existing;
  }

  /**
   * 批量查询某用户收藏的文档 id 集合（供列表页标记星标）
   */
  private async getFavoritedIds(
    docIds: string[],
    userId: string,
  ): Promise<Set<string>> {
    if (docIds.length === 0) return new Set();
    const rows = await this.favoriteRepo
      .createQueryBuilder('f')
      .select(['f.documentId'])
      .where('f.userId = :uid AND f.documentId IN (:...ids)', {
        uid: userId,
        ids: docIds,
      })
      .getRawMany();
    return new Set(rows.map((r) => r.document_id));
  }

  /**
   * 批量查 User 表，返回 userId → username 映射（供列表展示创建者名）
   */
  private async getUserNames(
    userIds: (string | null)[],
  ): Promise<Map<string, string>> {
    const ids = Array.from(
      new Set(userIds.filter((x): x is string => !!x)),
    );
    if (ids.length === 0) return new Map();
    const userRepo = this.entityManager.getRepository('User');
    const users = await userRepo
      .createQueryBuilder('u')
      .select(['u.id', 'u.username'])
      .where('u.id IN (:...ids)', { ids })
      .getRawMany();
    return new Map(users.map((u) => [u.id, u.username]));
  }

  /**
   * 把 Document 实体列表映射为 DocumentListItem，附加创建者名 + 收藏状态
   */
  private async toListItems(
    docs: Document[],
    user: AuthUser,
  ): Promise<DocumentListItem[]> {
    const userIds = docs.map((d) => d.createdBy);
    const [nameMap, favIds] = await Promise.all([
      this.getUserNames(userIds),
      this.getFavoritedIds(
        docs.map((d) => d.id),
        user.id,
      ),
    ]);
    return docs.map((d) => ({
      id: d.id,
      title: d.title,
      format: d.format,
      version: d.version,
      tags: d.tags ?? [],
      updatedAt: d.updatedAt,
      createdBy: d.createdBy,
      createdByName: d.createdBy ? nameMap.get(d.createdBy) ?? null : null,
      ownerType: d.ownerType,
      ownerId: d.ownerId,
      favorited: favIds.has(d.id),
    }));
  }

  /**
   * 我的文档：当前用户创建的所有文档（按 updatedAt DESC）
   */
  async findMyDocuments(user: AuthUser): Promise<DocumentListItem[]> {
    const qb = this.documentRepo
      .createQueryBuilder('d')
      .where('d.created_by = :uid', { uid: user.id })
      .orderBy('d.updatedAt', 'DESC');
    // 我的文档天然在用户读权限范围内（个人创建），无需再 applyReadScopeToQb
    const docs = await qb.getMany();
    return this.toListItems(docs, user);
  }

  /**
   * 我的收藏：当前用户收藏的文档（按收藏时间 DESC）
   */
  async findFavorites(user: AuthUser): Promise<DocumentListItem[]> {
    const qb = this.documentRepo
      .createQueryBuilder('d')
      .innerJoin(
        DocumentFavorite,
        'f',
        'f.documentId = d.id AND f.userId = :uid',
        { uid: user.id },
      )
      .orderBy('f.createdAt', 'DESC');
    this.accessControl.applyReadScopeToQb(qb, user);
    const docs = await qb.getMany();
    return this.toListItems(docs, user);
  }

  /**
   * 我的组文档：当前用户所在组织（含祖先链）下的文档
   * 用于"我的组/我的部门"快捷入口
   */
  async findMyOrgDocuments(user: AuthUser): Promise<DocumentListItem[]> {
    const ancestorIds = this.accessControl.ancestorOrgIds(user);
    if (ancestorIds.length === 0) {
      return [];
    }
    const qb = this.documentRepo
      .createQueryBuilder('d')
      .where(
        'd.ownerType IN (:...types) AND d.ownerId IN (:...orgIds)',
        {
          types: [DocumentOwnerType.GROUP, DocumentOwnerType.DEPARTMENT],
          orgIds: ancestorIds,
        },
      )
      .orderBy('d.updatedAt', 'DESC');
    const docs = await qb.getMany();
    return this.toListItems(docs, user);
  }

  /**
   * 标签聚合：返回所有文档中出现的标签及其文档计数（按计数 DESC）
   * 用于"标签云"快捷入口，跨分类横切检索
   */
  async getTagsWithCount(user: AuthUser): Promise<{ tag: string; count: number }[]> {
    // unnest tags 数组为行，按读权限过滤后聚合计数
    const qb = this.documentRepo
      .createQueryBuilder('d')
      .select(['unnest(d.tags) AS tag', 'COUNT(*) AS count'])
      .groupBy('tag')
      .orderBy('count', 'DESC')
      .addOrderBy('tag', 'ASC');
    this.accessControl.applyReadScopeToQb(qb, user);
    const rows = await qb.getRawMany();
    return rows.map((r) => ({
      tag: r.tag,
      count: Number(r.count),
    }));
  }
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 文档格式枚举
 *
 * 主文档格式（含 kkFileView 支持的 office 类格式，正文不可解析的格式 content 为空，
 * 仅通过 kkFileView 预览）：
 * - 可解析正文：md / txt / docx / odt / pdf（走 docling/pandoc/pdf-parse）
 * - 仅预览：doc / xls / xlsx / ppt / pptx / csv / tsv / wps / dps / et / ett / wpt
 *           ods / odp / ott / fodt / fods
 * - 版式/富文本：ofd / rtf
 * - Office 宏/模板：xlsm / dotm / xlt / xltm / dot / xlam / dotx / xla / pptm
 * - OpenOffice 模板：ots / otp / six
 *
 * 注：Visio/CAD/3D模型/音视频/压缩包等纯预览型格式不作为主文档（无文档语义），
 *     仅作为附件上传（附件白名单覆盖 kkFileView 全格式，不经过此 enum）。
 */
export enum DocumentFormat {
  MD = 'md',
  TXT = 'txt',
  DOCX = 'docx',
  ODT = 'odt',
  PDF = 'pdf',
  DOC = 'doc',
  XLS = 'xls',
  XLSX = 'xlsx',
  PPT = 'ppt',
  PPTX = 'pptx',
  CSV = 'csv',
  TSV = 'tsv',
  WPS = 'wps',
  DPS = 'dps',
  ET = 'et',
  ETT = 'ett',
  WPT = 'wpt',
  ODS = 'ods',
  ODP = 'odp',
  OTT = 'ott',
  FODT = 'fodt',
  FODS = 'fods',
  // 版式/富文本
  OFD = 'ofd',
  RTF = 'rtf',
  // Office 宏/模板
  XLSM = 'xlsm',
  DOTM = 'dotm',
  XLT = 'xlt',
  XLTM = 'xltm',
  DOT = 'dot',
  XLAM = 'xlam',
  DOTX = 'dotx',
  XLA = 'xla',
  PPTM = 'pptm',
  // OpenOffice 模板
  OTS = 'ots',
  OTP = 'otp',
  SIX = 'six',
}

/**
 * 文档归属类型
 * - personal: 个人私有空间，ownerId = 创建者 user id
 * - group: 归属某组，ownerId = organization id
 * - department: 归属某部门，ownerId = organization id
 */
export enum DocumentOwnerType {
  PERSONAL = 'personal',
  GROUP = 'group',
  DEPARTMENT = 'department',
}

/**
 * 正文来源
 * - manual: 用户手写/编辑的 md/txt
 * - pandoc: docx 经 pandoc 抽取的索引文本（仅检索，docx 走 OnlyOffice 编辑）
 * - pdf_text: pdf-parse 提取的全文
 * - onlyoffice: docx 由 OnlyOffice 回写标记
 * - ai_summary: AI（GLM5.2）基于原文档生成的总结文档，采用 Docsify 风格渲染
 * - docling: 由 docling-serve 统一解析（支持 PDF 图片/表格/版式/OCR）
 */
export enum ContentSource {
  MANUAL = 'manual',
  PANDOC = 'pandoc',
  PDF_TEXT = 'pdf_text',
  ONLYOFFICE = 'onlyoffice',
  AI_SUMMARY = 'ai_summary',
  DOCLING = 'docling',
}

/**
 * 文档实体
 * title 上加普通 B-tree 索引（用于精确查询/排序）
 * content 为全文 text，B-tree 索引行有 8191 字节上限，长文档会超限报错；
 * 故 content 不建 B-tree，全文搜索走 GIN trigram 索引（AppModule.onApplicationBootstrap 原始 SQL 创建）
 */
@Entity('documents')
export class Document {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Index()
  @Column({ name: 'category_id', type: 'uuid' })
  categoryId: string;

  @Index()
  @Column({ type: 'varchar', length: 200 })
  title: string;

  // content 不加 @Index()：B-tree 索引行有 8191 字节上限，长文档超限会报错；
  // 全文搜索由 GIN trigram 索引（idx_documents_content_trgm）覆盖
  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ type: 'enum', enum: DocumentFormat })
  format: DocumentFormat;

  // 原始文件相对路径，如 original/<docId>/<file>
  @Column({ name: 'original_path', type: 'varchar', nullable: true })
  originalPath: string | null;

  // PDF 页数（仅 PDF 格式有值，其他格式为 null）
  @Column({ type: 'int', nullable: true })
  pages: number | null;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'varchar', default: 'anonymous' })
  author: string;

  // PostgreSQL text[] 数组类型，默认空数组
  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  // 创建者用户 id（关联 users.id），用于"我的文档"视图与权限判断
  @Index()
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  // 文档归属类型与归属 id：
  // personal → ownerId = 创建者 user id；group/department → ownerId = organization id
  @Index()
  @Column({
    name: 'owner_type',
    type: 'enum',
    enum: DocumentOwnerType,
    default: DocumentOwnerType.PERSONAL,
  })
  ownerType: DocumentOwnerType;

  @Column({ name: 'owner_id', type: 'uuid', nullable: true })
  ownerId: string | null;

  // 正文来源，前端据此决定 docx 走 OnlyOffice 而非 Vditor；搜索据此决定是否纳入全文索引
  @Column({
    name: 'content_source',
    type: 'enum',
    enum: ContentSource,
    default: ContentSource.MANUAL,
  })
  contentSource: ContentSource;

  // 源文档 id（仅 AI 总结文档有值）：指向被总结的原文档，用于反向追溯与阅读页"查看原文"入口
  // 普通文档为 null。单向关联：原文档不存 summaryDocId，需查总结文档时按 source_doc_id 反查
  @Index()
  @Column({ name: 'source_doc_id', type: 'uuid', nullable: true })
  sourceDocId: string | null;

  // 知识库路径（仅 AI 总结文档有值）：由 LLM 在 summarize 时根据原文档内容生成的分类路径，
  // 格式如 "技术文档/操作系统/Linux"。前端按此字段构建 AI 知识库树形导航。
  // 普通文档为 null。可手动编辑修正。
  @Index()
  @Column({ name: 'knowledge_path', type: 'varchar', length: 500, nullable: true })
  knowledgePath: string | null;

  // 是否为文档集合（容器文档）：true 表示此文档是一个"文档集"，
  // 自身无正文 content，通过 document_attachments 表关联多个成员文档（引用方式）。
  // 集合级附件也通过 document_attachments 表关联（attach_type='file'）。
  // 普通文档为 false。
  @Column({ name: 'is_collection', type: 'boolean', default: false })
  isCollection: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

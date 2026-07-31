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
 */
export enum DocumentFormat {
  MD = 'md',
  TXT = 'txt',
  DOCX = 'docx',
  ODT = 'odt',
  PDF = 'pdf',
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
 * title/content 上加普通 B-tree 索引（用于精确查询）
 * GIN trigram 索引在 AppModule.onApplicationBootstrap 中通过原始 SQL 创建
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

  @Index()
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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

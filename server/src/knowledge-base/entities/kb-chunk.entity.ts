import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * chunk 类型枚举
 * - text: 正文段落
 * - table: 表格（整表为一个 chunk）
 * - code: 代码块（整块为一个 chunk，不切分）
 * - image_desc: 图片描述（docling OCR/描述生成的文本）
 */
export enum ChunkType {
  TEXT = 'text',
  TABLE = 'table',
  CODE = 'code',
  IMAGE_DESC = 'image_desc',
}

/**
 * 知识库 chunk 实体
 *
 * 每个文档加入知识库后，按 chunk 策略切分为多个 chunk，每个 chunk 生成 embedding 向量。
 *
 * embedding 列由 AppModule.onApplicationBootstrap 的 raw SQL 创建（vector(1024) 类型），
 * TypeORM 不原生支持 pgvector 类型，故实体中不定义 embedding 列，查询时用 raw SQL。
 *
 * 重要：synchronize=false 阻止 TypeORM 同步此表 schema。
 * 因实体未定义 embedding 列，若 synchronize=true，TypeORM 每次启动会 DROP 该列，
 * 导致已写入的 embedding 数据丢失。设为 false 后，表结构完全由 raw SQL 管理。
 *
 * 表名 kb_chunks（复数）。
 */
@Entity('kb_chunks', { synchronize: false })
export class KbChunk {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  /** 所属知识库 */
  @Index()
  @Column({ name: 'kb_id', type: 'uuid' })
  kbId: string;

  /** 关联文档（documents.id） */
  @Index()
  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  /** chunk 在文档中的序号（从 0 开始） */
  @Column({ name: 'chunk_index', type: 'int' })
  chunkIndex: number;

  /** chunk 文本内容 */
  @Column({ type: 'text' })
  content: string;

  /**
   * 父 chunk id（parent-child 聚合策略用）
   * 细 chunk 命中检索后，返回时聚合到 parent chunk 提供完整上下文。
   * null 表示此 chunk 自身就是顶层 chunk。
   */
  @Column({ name: 'parent_chunk_id', type: 'uuid', nullable: true })
  parentChunkId: string | null;

  /**
   * 标题路径（如 "第一章 > 1.2 系统架构 > 1.2.3 数据层"）
   * chunk 所在章节的完整标题层级，用于引用展示与上下文定位。
   */
  @Column({ name: 'heading_path', type: 'text', nullable: true })
  headingPath: string | null;

  /** chunk 类型 */
  @Column({
    name: 'chunk_type',
    type: 'enum',
    enum: ChunkType,
    default: ChunkType.TEXT,
  })
  chunkType: ChunkType;

  /**
   * 元数据（JSONB）
   * { page: 3, position: 'paragraph', tokenCount: 480, imageRef: 'images/xxx.png' }
   */
  @Column({ type: 'jsonb', default: '{}' })
  metadata: Record<string, any>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /*
   * embedding 列（vector(1024)）由 raw SQL 创建，此处不定义。
   * 读写方式：
   *   写入: INSERT INTO kb_chunks (..., embedding) VALUES (..., '[0.1,0.2,...]'::vector)
   *   检索: SELECT *, embedding <=> $1::vector AS distance FROM kb_chunks ORDER BY distance LIMIT K
   *   <=> = cosine distance, <#> = inner product, <-> = L2 distance
   */
}

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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

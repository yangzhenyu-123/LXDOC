import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';

/**
 * 文档版本快照实体
 * 每次文档内容更新时写入一条历史版本快照
 * (document_id, version) 唯一
 */
@Entity('document_versions')
@Unique(['documentId', 'version'])
export class DocumentVersion {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Index()
  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'text' })
  content: string;

  // 快照文件相对路径（若内容过大单独存盘）
  @Column({ name: 'snapshot_path', type: 'varchar', nullable: true })
  snapshotPath: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

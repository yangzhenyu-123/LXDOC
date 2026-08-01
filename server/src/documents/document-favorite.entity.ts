import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';

/**
 * 文档收藏（星标）关系实体
 * 用户与文档的多对多收藏关系，用于"我的收藏"快捷入口
 * (user_id, document_id) 唯一，避免重复收藏
 */
@Entity('document_favorites')
@Unique(['userId', 'documentId'])
export class DocumentFavorite {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Index()
  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

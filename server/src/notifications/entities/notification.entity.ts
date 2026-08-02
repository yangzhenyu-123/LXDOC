import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * 通知类型
 * - kb_ingestion_request   ：入库申请通知（发给审核人）
 * - kb_ingestion_approved  ：入库通过通知（发给申请人）
 * - kb_ingestion_rejected   ：入库被拒绝通知（发给申请人，仅记录意见）
 * - kb_ingestion_revoked    ：入库申请被撤销通知（发给审核人）
 * - kb_ingestion_done       ：入库完成通知（发给申请人）
 */
export enum NotificationType {
  KB_INGESTION_REQUEST = 'kb_ingestion_request',
  KB_INGESTION_APPROVED = 'kb_ingestion_approved',
  KB_INGESTION_REJECTED = 'kb_ingestion_rejected',
  KB_INGESTION_REVOKED = 'kb_ingestion_revoked',
  KB_INGESTION_DONE = 'kb_ingestion_done',
}

/**
 * 站内通知实体
 *
 * 设计权衡（已采纳用户决策）：不做邮件，仅站内消息。
 * - userId 索引，便于按用户分页查询
 * - readAt 为 null 表示未读，非 null 表示已读时间
 * - payload 存附加数据（requestId / kbId / documentId 等），供前端跳转
 */
@Entity('notifications')
@Index(['userId'])
@Index(['userId', 'readAt'])
export class Notification {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 50 })
  type: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, any> | null;

  /** null = 未读，非 null = 已读时间 */
  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

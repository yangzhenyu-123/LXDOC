import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * 审计动作枚举
 * 记录关键操作类型，便于按 action 筛选
 */
export enum AuditAction {
  LOGIN = 'login',
  LOGOUT = 'logout',
  DOCUMENT_CREATE = 'document_create',
  DOCUMENT_UPDATE = 'document_update',
  DOCUMENT_DELETE = 'document_delete',
  CATEGORY_CREATE = 'category_create',
  CATEGORY_DELETE = 'category_delete',
  USER_CREATE = 'user_create',
  USER_UPDATE = 'user_update',
  USER_DELETE = 'user_delete',
  PERMISSION_CHANGE = 'permission_change',
  // 知识库相关（TODO 2.3：高权限操作留痕，防数据污染）
  KB_CREATE = 'kb_create',
  KB_UPDATE = 'kb_update',
  KB_DELETE = 'kb_delete',
  KB_DOCUMENT_ADD = 'kb_document_add',
  KB_DOCUMENT_REMOVE = 'kb_document_remove',
  KB_EXPORT = 'kb_export',
  // 知识库入库审核（与 addDocument 区分：审核动作留痕）
  KB_INGESTION_CREATE = 'kb_ingestion_create',
  KB_INGESTION_APPROVE = 'kb_ingestion_approve',
  KB_INGESTION_REJECT = 'kb_ingestion_reject',
  KB_INGESTION_REVOKE = 'kb_ingestion_revoke',
}

/**
 * 审计日志实体
 * 记录登录/登出/文档与分类 CRUD/用户管理/权限变更等关键操作
 * userId / action / createdAt 加索引，便于按用户、动作、时间范围筛选
 */
@Entity('audit_logs')
export class AuditLog {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Index()
  @Column({ type: 'enum', enum: AuditAction })
  action: AuditAction;

  @Column({ name: 'target_type', type: 'varchar', length: 50, nullable: true })
  targetType: string | null;

  @Column({ name: 'target_id', type: 'uuid', nullable: true })
  targetId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  detail: Record<string, any> | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  ip: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @Index()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

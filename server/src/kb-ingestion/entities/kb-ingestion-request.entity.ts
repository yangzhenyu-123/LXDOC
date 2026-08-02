import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 知识库入库申请状态机
 *
 * - pending   ：待审核（创建后初始态）
 * - approved  ：任一审核通过（first-write-wins），后续审核仅补录意见
 * - done      ：入库流程完成（chunking + embedding + 入库 kb_chunks）
 * - revoked   ：申请人撤销
 * - closed    ：撤销后终态（占位，便于审计与列表筛选）
 *
 * 状态迁移：
 *   pending --approve(任一)--> approved --入库成功--> done
 *   pending --revoke(申请人)--> revoked --> closed
 *   pending --reject(审核员)--> 仍保持 pending（拒绝仅记录意见，不强制终结）
 *
 * 注：拒绝不改 status，仅落 kb_ingestion_reviews.decision='reject' 一行。
 *     申请人若要终结流程，需主动 revoke。
 */
export enum IngestionRequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  DONE = 'done',
  REVOKED = 'revoked',
  CLOSED = 'closed',
}

/**
 * 知识库入库申请实体
 *
 * 触发场景：当 KB.requireReview=true 时，组员发起 addDocument 走审核流。
 * 审核人 = 文档 owner 所属组的 UserOrgRole.admin ∪ 所属部门（沿 path 上溯）的 UserOrgRole.admin
 *
 * 并发控制：partial unique index 限制同一 (kbId, documentId) 同时只能有一个 pending/approved 请求
 *           （由 AppModule.onApplicationBootstrap 显式创建，TypeORM synchronize 不支持 partial index）
 */
@Entity('kb_ingestion_requests')
export class KbIngestionRequest {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Index()
  @Column({ name: 'kb_id', type: 'uuid' })
  kbId: string;

  @Index()
  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  /** 申请人（发起 addDocument 的用户） */
  @Index()
  @Column({ name: 'requester_id', type: 'uuid' })
  requesterId: string;

  /** 申请说明（可选） */
  @Column({ name: 'requester_note', type: 'text', nullable: true })
  requesterNote: string | null;

  @Column({
    type: 'enum',
    enum: IngestionRequestStatus,
    default: IngestionRequestStatus.PENDING,
  })
  status: IngestionRequestStatus;

  /** 首个审核通过者（first-write-wins 标记） */
  @Index()
  @Column({ name: 'resolved_by_id', type: 'uuid', nullable: true })
  resolvedById: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  /** 入库结果：生成 chunk 数（done 状态有值） */
  @Column({ name: 'result_chunk_count', type: 'int', nullable: true })
  resultChunkCount: number | null;

  /** 入库失败原因（done 状态但失败时存错误信息） */
  @Column({ name: 'result_error', type: 'text', nullable: true })
  resultError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

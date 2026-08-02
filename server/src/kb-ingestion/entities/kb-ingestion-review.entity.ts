import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';

/**
 * 审核决定
 * - approve：通过（任一通过立即触发入库，后续审核仅补录意见）
 * - reject ：拒绝（仅记录意见，不强制终结申请）
 */
export enum ReviewDecision {
  APPROVE = 'approve',
  REJECT = 'reject',
}

/**
 * 知识库入库审核记录
 *
 * 一个 request 可有多条 review（多个审核人各审一次）。
 * 同一审核人对同一 request 只能审一次（由唯一约束保证）。
 *
 * first-write-wins 语义：第一个 approve 触发入库；后续 approve 仅记录意见，不重复触发。
 * `is_first_approval` 标记首通过者，便于审计与列表展示。
 */
@Entity('kb_ingestion_reviews')
@Unique('uq_request_reviewer', ['requestId', 'reviewerId'])
@Index(['requestId'])
@Index(['reviewerId'])
export class KbIngestionReview {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ name: 'request_id', type: 'uuid' })
  requestId: string;

  @Column({ name: 'reviewer_id', type: 'uuid' })
  reviewerId: string;

  @Column({ type: 'enum', enum: ReviewDecision })
  decision: ReviewDecision;

  @Column({ type: 'text', nullable: true })
  comment: string | null;

  /** 是否为首个通过（first-write-wins 标记，仅一条 approve 会置 true） */
  @Column({ name: 'is_first_approval', type: 'boolean', default: false })
  isFirstApproval: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

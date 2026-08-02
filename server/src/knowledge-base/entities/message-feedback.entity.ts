import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * RAG 消息反馈实体（P9 候选 3）
 *
 * 用户对 assistant 回答的点赞/点踩记录，用于 RAG 质量评估与持续优化。
 * 前端在 done 事件拿到 messageId 后，用户点踩时弹窗写理由，调 POST /feedback 存到这里。
 *
 * 唯一索引 (messageId, userId)：同一用户对同一回答只能评分一次
 */
@Entity({ name: 'rag_message_feedback' })
@Index('idx_msg_user', ['messageId', 'userId'], { unique: true })
@Index('idx_kb', ['kbId'])
@Index('idx_user', ['userId'])
export class MessageFeedback {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 一次 RAG 回答的唯一标识（后端在 done 事件生成 uuid 返回给前端） */
  @Column({ name: 'message_id', type: 'uuid' })
  messageId: string;

  /** 关联知识库（便于按 KB 聚合分析反馈） */
  @Column({ name: 'kb_id', type: 'uuid' })
  kbId: string;

  /** 提交反馈的用户 */
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** 评分：1 = 点赞（满意），-1 = 点踩（不满意） */
  @Column({ type: 'smallint' })
  rating: number;

  /** 点踩理由（仅 rating=-1 时填写，nullable） */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

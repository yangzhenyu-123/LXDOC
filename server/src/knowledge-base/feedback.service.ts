import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageFeedback } from './entities/message-feedback.entity';

/**
 * 消息反馈服务（P9 候选 3）
 *
 * 用户对 RAG 回答点赞/点踩，存表用于质量评估。
 * 唯一约束 (messageId, userId) 防重复评分：upsert 语义，已存在则更新 rating/reason。
 */
@Injectable()
export class FeedbackService {
  constructor(
    @InjectRepository(MessageFeedback)
    private readonly feedbackRepo: Repository<MessageFeedback>,
  ) {}

  /**
   * 提交反馈
   * @param userId 当前用户 id
   * @param messageId RAG done 事件返回的 uuid
   * @param kbId 关联知识库
   * @param rating 1=点赞 / -1=点踩
   * @param reason 点踩理由（点踩时必填）
   */
  async create(
    userId: string,
    messageId: string,
    kbId: string,
    rating: number,
    reason?: string,
  ): Promise<MessageFeedback> {
    // 点踩时理由必填（点赞可不填）
    if (rating === -1 && !reason?.trim()) {
      throw new BadRequestException('点踩反馈需要填写理由');
    }

    // upsert：同一 (messageId, userId) 已存在则更新，否则插入
    const existing = await this.feedbackRepo.findOne({
      where: { messageId, userId },
    });

    if (existing) {
      existing.rating = rating;
      existing.reason = rating === -1 ? (reason ?? null) : null;
      return this.feedbackRepo.save(existing);
    }

    const fb = this.feedbackRepo.create({
      messageId,
      kbId,
      userId,
      rating,
      reason: rating === -1 ? (reason ?? null) : null,
    });
    return this.feedbackRepo.save(fb);
  }
}

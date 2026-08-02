import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * 创建消息反馈 DTO（P9 候选 3）
 *
 * 用户对 assistant 回答点赞/点踩。messageId 来自 RAG done 事件返回的 uuid。
 * rating=1 点赞，rating=-1 点踩（点踩时 reason 必填）。
 */
export class CreateFeedbackDto {
  @IsUUID()
  messageId: string;

  @IsUUID()
  kbId: string;

  @IsInt()
  @IsIn([1, -1])
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

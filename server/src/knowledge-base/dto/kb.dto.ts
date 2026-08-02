import { IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
/**
 * 创建知识库 DTO
 */
export class CreateKbDto {
  @IsString()
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  /** chunk 切分策略（JSON，可选） */
  @IsOptional()
  chunkStrategy?: Record<string, any>;

  /** 是否要求入库审核（默认 false） */
  @IsOptional()
  @IsBoolean()
  requireReview?: boolean;
}

/**
 * 更新知识库 DTO
 */
export class UpdateKbDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  chunkStrategy?: Record<string, any>;

  @IsOptional()
  retrievalConfig?: Record<string, any>;

  /** 是否要求入库审核 */
  @IsOptional()
  @IsBoolean()
  requireReview?: boolean;
}

/**
 * 加入文档到知识库 DTO
 */
export class AddDocumentDto {
  @IsUUID()
  documentId: string;
}

/**
 * 检索 DTO
 */
export class RetrieveDto {
  @IsString()
  query: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  topK?: number;
}

/**
 * 历史对话消息（多轮对话用）
 *
 * 仅 user/assistant 两种角色，按时间顺序排列。
 * 后端会截断最近 N 轮 + 总字符上限，避免 prompt 过长。
 */
export class HistoryMessageDto {
  @IsString()
  role: 'user' | 'assistant';

  @IsString()
  @MaxLength(4000)
  content: string;
}

/**
 * RAG 问答 DTO
 *
 * - query：当前问题
 * - history：历史对话（可选，多轮对话用），最近 N 轮 + 总字符上限由后端截断
 * - documentIds：限定检索文档范围（可选，文档选择器用），空则全 KB 检索
 */
export class AskDto {
  @IsString()
  @MaxLength(2000)
  query: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HistoryMessageDto)
  history?: HistoryMessageDto[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  documentIds?: string[];
}

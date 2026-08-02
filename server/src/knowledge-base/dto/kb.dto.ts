import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

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
}

/**
 * 更新知识库 DTO
 */
export class UpdateKbDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  chunkStrategy?: Record<string, any>;

  @IsOptional()
  retrievalConfig?: Record<string, any>;
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
 * RAG 问答 DTO
 */
export class AskDto {
  @IsString()
  @MaxLength(2000)
  query: string;
}

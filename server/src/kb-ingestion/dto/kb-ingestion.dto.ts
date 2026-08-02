import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * 创建入库申请 DTO
 *
 * 调用方：任何登录用户（组员）。
 * Service 内部判断：
 * - KB.requireReview=false → 直接调用 kbService.addDocument（无审核）
 * - KB.requireReview=true  → 创建 request，等待审核
 */
export class CreateIngestionRequestDto {
  @IsUUID()
  kbId: string;

  @IsUUID()
  documentId: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/**
 * 审核决定 DTO
 */
export class ReviewIngestionRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

/**
 * 撤销申请 DTO
 */
export class RevokeIngestionRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

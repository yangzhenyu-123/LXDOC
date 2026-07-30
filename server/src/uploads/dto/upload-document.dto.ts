import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentOwnerType } from '../../documents/document.entity';

/**
 * 文档上传 DTO
 * - categoryId 必填，需为 uuid
 * - ownerType 可选，默认 personal；group/department 时需提供 ownerId
 * - ownerId 可选，organization id（ownerType 为 group/department 时必填）
 */
export class UploadDocumentDto {
  @IsUUID()
  categoryId: string;

  @IsOptional()
  @IsEnum(DocumentOwnerType)
  ownerType?: DocumentOwnerType;

  @IsOptional()
  @IsUUID()
  ownerId?: string;
}

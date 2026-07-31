import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentOwnerType } from '../../documents/document.entity';

/**
 * 文档上传 DTO
 * - categoryId 必填，需为 uuid
 * - ownerType 可选，默认 personal；group/department 时需提供 ownerId
 * - ownerId 可选，organization id（ownerType 为 group/department 时必填）
 */
export class UploadDocumentDto {
  @ApiProperty({ description: '所属分类 id', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsUUID()
  categoryId: string;

  @ApiPropertyOptional({ description: '文档归属类型（默认 personal）', enum: DocumentOwnerType, example: 'personal' })
  @IsOptional()
  @IsEnum(DocumentOwnerType)
  ownerType?: DocumentOwnerType;

  @ApiPropertyOptional({ description: '归属组织 id（ownerType 为 group/department 时必填）', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsOptional()
  @IsUUID()
  ownerId?: string;
}

import { IsUUID } from 'class-validator';

/**
 * 文档上传 DTO
 * categoryId 必填，需为 uuid
 */
export class UploadDocumentDto {
  @IsUUID()
  categoryId: string;
}

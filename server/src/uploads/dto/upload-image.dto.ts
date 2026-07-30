import { IsOptional, IsUUID } from 'class-validator';

/**
 * 图片上传 DTO
 * docId 可为空，为空时图片落到 temp 目录
 */
export class UploadImageDto {
  @IsOptional()
  @IsUUID()
  docId?: string | null;
}

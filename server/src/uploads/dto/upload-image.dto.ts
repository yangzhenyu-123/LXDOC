import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 图片上传 DTO
 * docId 可为空，为空时图片落到 temp 目录
 */
export class UploadImageDto {
  @ApiPropertyOptional({ description: '关联文档 id（为空时图片落到 temp 目录）', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsOptional()
  @IsUUID()
  docId?: string | null;
}

import {
  IsArray,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 更新文档 DTO
 * 所有字段均可选，仅传入的字段会被更新
 */
export class UpdateDocumentDto {
  @ApiPropertyOptional({ description: '文档标题（1-200 位）', example: 'LXDOC 使用指南' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @ApiPropertyOptional({ description: '文档正文内容', example: '# 标题\n\n这是正文内容' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({ description: '标签列表', type: [String], example: ['指南', '前端'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

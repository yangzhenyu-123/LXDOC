import {
  IsArray,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

/**
 * 更新文档 DTO
 * 所有字段均可选，仅传入的字段会被更新
 */
export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

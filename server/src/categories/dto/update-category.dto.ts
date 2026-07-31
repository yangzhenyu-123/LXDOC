import { IsInt, IsOptional, IsString, Length } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * 更新分类 DTO
 * 仅允许修改 name 与 sort，所有字段可选
 * type 不可变更（继承关系决定）
 */
export class UpdateCategoryDto {
  @ApiPropertyOptional({ description: '分类名称（1-100 位）', example: '前端指南' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional({ description: '排序值', example: 0 })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sort?: number;
}

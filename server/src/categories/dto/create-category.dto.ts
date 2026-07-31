import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CategoryType } from '../category.entity';

/**
 * 创建分类 DTO
 * - parentId 省略时表示顶层分类，此时 type 必填
 * - 提供 parentId 时 type 自动继承父级，无需传入
 */
export class CreateCategoryDto {
  @ApiPropertyOptional({ description: '父级分类 id（省略表示顶层分类）', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiProperty({ description: '分类名称（1-100 位）', example: '前端指南' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiPropertyOptional({ description: '分类类型（顶层必填，子分类继承父级）', enum: CategoryType, example: 'tech_doc' })
  @IsOptional()
  @IsEnum(CategoryType)
  type?: CategoryType;

  @ApiPropertyOptional({ description: '排序值', example: 0 })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sort?: number;
}

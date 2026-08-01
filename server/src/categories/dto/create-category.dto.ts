import { IsInt, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * 创建分类 DTO
 * - parentId 省略时表示顶层分类，此时 type 必填
 * - 提供 parentId 时 type 自动继承父级，无需传入
 * - type 为字符串（最长 50 位），不再受枚举约束，支持自定义类型名
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

  @ApiPropertyOptional({ description: '分类类型（顶层必填，子分类继承父级）。任意字符串，如 tech_doc / regulation / os_knowledge', example: 'tech_doc' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  @ApiPropertyOptional({ description: '排序值', example: 0 })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sort?: number;
}

import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Type } from 'class-transformer';
import { CategoryType } from '../category.entity';

/**
 * 创建分类 DTO
 * - parentId 省略时表示顶层分类，此时 type 必填
 * - 提供 parentId 时 type 自动继承父级，无需传入
 */
export class CreateCategoryDto {
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsString()
  @Length(1, 100)
  name: string;

  @IsOptional()
  @IsEnum(CategoryType)
  type?: CategoryType;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sort?: number;
}

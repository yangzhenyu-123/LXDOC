import { IsInt, IsOptional, IsString, Length } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 更新分类 DTO
 * 仅允许修改 name 与 sort，所有字段可选
 * type 不可变更（继承关系决定）
 */
export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sort?: number;
}

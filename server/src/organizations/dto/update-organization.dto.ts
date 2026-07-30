import { IsInt, IsOptional, IsString, Length } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 更新组织节点 DTO
 * 仅支持改名 / 排序，不支持移动 parent（避免子树 path 重算复杂度）
 */
export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sort?: number;
}

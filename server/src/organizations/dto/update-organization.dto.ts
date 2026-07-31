import { IsInt, IsOptional, IsString, Length } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * 更新组织节点 DTO
 * 仅支持改名 / 排序，不支持移动 parent（避免子树 path 重算复杂度）
 */
export class UpdateOrganizationDto {
  @ApiPropertyOptional({ description: '组织名称（1-100 位）', example: '研发部' })
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

import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { OrganizationType } from '../organization.entity';

/**
 * 创建组织节点 DTO
 * - type=department 时 parentId 必须为空（顶层）
 * - type=group 时 parentId 必填且指向某个 department
 */
export class CreateOrganizationDto {
  @ApiProperty({ description: '组织节点类型（department 顶层部门 / group 组）', enum: OrganizationType, example: 'department' })
  @IsEnum(OrganizationType)
  type: OrganizationType;

  @ApiProperty({ description: '组织名称（1-100 位）', example: '研发部' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiPropertyOptional({ description: '父节点 id（group 时必填，department 时为空）', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional({ description: '排序值', example: 0 })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sort?: number;
}

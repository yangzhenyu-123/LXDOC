import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrganizationType } from '../organization.entity';

/**
 * 创建组织节点 DTO
 * - type=department 时 parentId 必须为空（顶层）
 * - type=group 时 parentId 必填且指向某个 department
 */
export class CreateOrganizationDto {
  @IsEnum(OrganizationType)
  type: OrganizationType;

  @IsString()
  @Length(1, 100)
  name: string;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sort?: number;
}

import { IsEnum, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserOrgRoleValue } from '../user-org-role.entity';

/**
 * 添加成员授权 DTO
 */
export class AddMemberDto {
  @ApiProperty({ description: '被授权用户 id', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsUUID()
  userId: string;

  @ApiProperty({ description: '成员角色（editor 可编辑 / admin 可管理）', enum: UserOrgRoleValue, example: 'editor' })
  @IsEnum(UserOrgRoleValue)
  role: UserOrgRoleValue;
}

/**
 * 更新成员授权角色 DTO
 */
export class UpdateMemberDto {
  @ApiProperty({ description: '成员角色（editor 可编辑 / admin 可管理）', enum: UserOrgRoleValue, example: 'editor' })
  @IsEnum(UserOrgRoleValue)
  role: UserOrgRoleValue;
}

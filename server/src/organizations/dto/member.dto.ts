import { IsEnum, IsUUID } from 'class-validator';
import { UserOrgRoleValue } from '../user-org-role.entity';

/**
 * 添加成员授权 DTO
 */
export class AddMemberDto {
  @IsUUID()
  userId: string;

  @IsEnum(UserOrgRoleValue)
  role: UserOrgRoleValue;
}

/**
 * 更新成员授权角色 DTO
 */
export class UpdateMemberDto {
  @IsEnum(UserOrgRoleValue)
  role: UserOrgRoleValue;
}

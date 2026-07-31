import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole, UserStatus } from '../user.entity';

/**
 * 更新用户请求 DTO
 * - 所有字段可选
 * - 不允许通过此接口修改 email / password（密码走 change-password）
 * 防误锁逻辑（不能把自己降级 / 禁用）在 service.update 中实现
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ description: '用户名（2-100 位）', example: '张三' })
  @IsOptional()
  @IsString()
  @Length(2, 100)
  username?: string;

  @ApiPropertyOptional({ description: '用户角色', enum: UserRole, example: 'editor' })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ description: '用户状态', enum: UserStatus, example: 'active' })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  // 所属组织节点 id，传 null 表示清除归属（变为无组织用户）
  @ApiPropertyOptional({ description: '所属组织节点 id，传 null 表示清除归属', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsOptional()
  @IsUUID()
  organizationId?: string | null;
}

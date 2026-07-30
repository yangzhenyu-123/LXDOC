import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { UserRole, UserStatus } from '../user.entity';

/**
 * 更新用户请求 DTO
 * - 所有字段可选
 * - 不允许通过此接口修改 email / password（密码走 change-password）
 * 防误锁逻辑（不能把自己降级 / 禁用）在 service.update 中实现
 */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(2, 100)
  username?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}

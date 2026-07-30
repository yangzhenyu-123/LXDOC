import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { UserRole } from '../user.entity';

/**
 * 管理员创建用户请求 DTO
 * - email 唯一
 * - username 唯一，长度 2-100
 * - password 长度 6-100（service 内 bcrypt.hash 后存 passwordHash）
 * - role 必填，admin / editor / viewer
 * - organizationId 可选，所属组织节点 id（通常为某 group）
 */
export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(2, 100)
  username: string;

  @IsString()
  @Length(6, 100)
  password: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsOptional()
  @IsUUID()
  organizationId?: string | null;
}

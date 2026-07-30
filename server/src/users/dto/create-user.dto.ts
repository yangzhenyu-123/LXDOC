import {
  IsEmail,
  IsEnum,
  IsString,
  Length,
} from 'class-validator';
import { UserRole } from '../user.entity';

/**
 * 管理员创建用户请求 DTO
 * - email 唯一
 * - username 唯一，长度 2-100
 * - password 长度 6-100（service 内 bcrypt.hash 后存 passwordHash）
 * - role 必填，admin / editor / viewer
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
}

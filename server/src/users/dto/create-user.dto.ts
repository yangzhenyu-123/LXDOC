import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiProperty({ description: '登录邮箱', example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: '用户名（2-100 位）', example: '张三' })
  @IsString()
  @Length(2, 100)
  username: string;

  @ApiProperty({ description: '密码（6-100 位）', example: 'password123' })
  @IsString()
  @Length(6, 100)
  password: string;

  @ApiProperty({ description: '用户角色', enum: UserRole, example: 'editor' })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiPropertyOptional({ description: '所属组织节点 id（通常为某 group）', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsOptional()
  @IsUUID()
  organizationId?: string | null;
}

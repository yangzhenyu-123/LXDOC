import { IsEmail, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 自注册请求 DTO
 */
export class RegisterDto {
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
}

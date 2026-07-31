import { IsEmail, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 登录请求 DTO
 */
export class LoginDto {
  @ApiProperty({ description: '登录邮箱', example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: '密码（6-100 位）', example: 'password123' })
  @IsString()
  @Length(6, 100)
  password: string;
}

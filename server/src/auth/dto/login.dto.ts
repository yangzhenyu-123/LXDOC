import { IsEmail, IsString, Length } from 'class-validator';

/**
 * 登录请求 DTO
 */
export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 100)
  password: string;
}

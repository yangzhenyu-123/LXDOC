import { IsEmail, IsString, Length } from 'class-validator';

/**
 * 自注册请求 DTO
 */
export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(2, 100)
  username: string;

  @IsString()
  @Length(6, 100)
  password: string;
}

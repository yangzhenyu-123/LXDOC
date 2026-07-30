import { IsString, Length } from 'class-validator';

/**
 * 修改密码请求 DTO
 */
export class ChangePasswordDto {
  @IsString()
  @Length(6, 100)
  oldPassword: string;

  @IsString()
  @Length(6, 100)
  newPassword: string;
}

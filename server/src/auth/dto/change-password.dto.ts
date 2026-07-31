import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 修改密码请求 DTO
 */
export class ChangePasswordDto {
  @ApiProperty({ description: '原密码（6-100 位）', example: 'oldpass123' })
  @IsString()
  @Length(6, 100)
  oldPassword: string;

  @ApiProperty({ description: '新密码（6-100 位）', example: 'newpass123' })
  @IsString()
  @Length(6, 100)
  newPassword: string;
}

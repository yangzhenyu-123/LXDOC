import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 刷新 token 请求 DTO
 */
export class RefreshDto {
  @ApiProperty({ description: '刷新令牌', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.signature' })
  @IsString()
  refreshToken: string;
}

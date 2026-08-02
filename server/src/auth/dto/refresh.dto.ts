import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 刷新 token 请求 DTO
 *
 * H8 修复：refresh token 改 httpOnly cookie 存储后，请求体无需再传 refreshToken。
 * 字段保留为可选以兼容旧客户端（cookie 优先，body 回退）。
 */
export class RefreshDto {
  @ApiProperty({
    description: '刷新令牌（已迁移至 httpOnly cookie，可省略；保留以兼容旧客户端）',
    required: false,
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.signature',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

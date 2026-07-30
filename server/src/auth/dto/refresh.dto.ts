import { IsString } from 'class-validator';

/**
 * 刷新 token 请求 DTO
 */
export class RefreshDto {
  @IsString()
  refreshToken: string;
}

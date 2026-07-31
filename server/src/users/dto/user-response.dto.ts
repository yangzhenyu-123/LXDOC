import { ApiProperty } from '@nestjs/swagger';
import { UserRole, UserStatus } from '../user.entity';

/**
 * 用户响应 DTO
 * 不含 passwordHash（User 实体 passwordHash 为 select:false，普通查询不返回）
 */
export class UserResponseDto {
  @ApiProperty({ description: '用户 id', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  id: string;

  @ApiProperty({ description: '登录邮箱', example: 'user@example.com' })
  email: string;

  @ApiProperty({ description: '用户名', example: '张三' })
  username: string;

  @ApiProperty({ description: '用户角色', enum: UserRole, example: 'editor' })
  role: UserRole;

  @ApiProperty({ description: '用户状态', enum: UserStatus, example: 'active' })
  status: UserStatus;

  @ApiProperty({ description: '创建时间', example: '2026-01-01T00:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ description: '更新时间', example: '2026-01-01T12:00:00.000Z' })
  updatedAt: Date;
}

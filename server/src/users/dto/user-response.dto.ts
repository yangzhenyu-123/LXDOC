import { UserRole, UserStatus } from '../user.entity';

/**
 * 用户响应 DTO
 * 不含 passwordHash（User 实体 passwordHash 为 select:false，普通查询不返回）
 */
export class UserResponseDto {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

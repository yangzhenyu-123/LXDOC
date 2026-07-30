import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthUser,
} from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { AuditAction } from '../audit/audit-log.entity';
import { UserRole } from './user.entity';

/**
 * 用户管理控制器
 * 全局前缀 /api，实际路径 /api/users
 * 所有用户管理接口仅 admin 可访问（类级 @Roles(UserRole.ADMIN)）
 * - GET    /api/users?page=&pageSize=  分页列表
 * - POST   /api/users                  创建用户
 * - PATCH  /api/users/:id              更新用户（防误锁：不能降级/禁用自己）
 * - DELETE /api/users/:id              删除用户（不能删自己、不能删最后一个 admin）
 */
@Roles(UserRole.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Get()
  findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const p = page !== undefined ? Number(page) : 1;
    const ps = pageSize !== undefined ? Number(pageSize) : 20;
    return this.service.findAll(
      Number.isFinite(p) ? p : 1,
      Number.isFinite(ps) ? ps : 20,
    );
  }

  @Post()
  @Audit(AuditAction.USER_CREATE, 'user')
  create(@Body() dto: CreateUserDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Audit(AuditAction.USER_UPDATE, 'user')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, dto, user);
  }

  @Delete(':id')
  @Audit(AuditAction.USER_DELETE, 'user')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.service.remove(id, user);
  }
}

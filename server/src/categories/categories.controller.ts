import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CategoryResponseDto } from './dto/category-response.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { AuditAction } from '../audit/audit-log.entity';
import { UserRole } from '../users/user.entity';

/**
 * 分类树控制器
 * 全局前缀 /api 由 main.ts 设置，此处使用 @Controller('categories')
 * 实际路径为 /api/categories
 * - GET    /api/categories        获取分类树（登录可读）
 * - GET    /api/categories/:id    获取单个分类（登录可读）
 * - POST   /api/categories        创建分类（editor+，createdBy 记录创建者）
 * - PATCH  /api/categories/:id    更新分类（editor+，editor 仅可改自己创建的）
 * - DELETE /api/categories/:id    删除分类（editor+，editor 仅可删自己创建的）
 */
@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  // 获取分类树（登录可读，无 @Roles）
  @Get()
  findAll(): Promise<CategoryResponseDto[]> {
    return this.service.findAll();
  }

  // 获取单个分类（登录可读，无 @Roles）
  @Get(':id')
  findOne(@Param('id') id: string): Promise<CategoryResponseDto> {
    return this.service.findOne(id);
  }

  // 创建分类（editor+）
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Audit(AuditAction.CATEGORY_CREATE, 'category')
  @Post()
  create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CategoryResponseDto> {
    return this.service.create(dto, user);
  }

  // 更新分类（editor+；editor 仅可改自己 createdBy 的分类，由 service 校验）
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CategoryResponseDto> {
    return this.service.update(id, dto, user);
  }

  // 删除分类（editor+；editor 仅可删自己 createdBy 的分类，由 service 校验）
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Audit(AuditAction.CATEGORY_DELETE, 'category')
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.service.remove(id, user);
  }
}

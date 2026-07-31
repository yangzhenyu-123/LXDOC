import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
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
@ApiTags('分类 Categories')
@ApiBearerAuth('access-token')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  // 获取分类树（登录可读，无 @Roles）
  @ApiOperation({ summary: '获取分类树' })
  @Get()
  findAll(@CurrentUser() user: AuthUser): Promise<CategoryResponseDto[]> {
    return this.service.findAll(user);
  }

  // 获取单个分类（登录可读，无 @Roles）
  @ApiOperation({ summary: '获取单个分类' })
  @ApiParam({ name: 'id', description: '分类 ID', type: String })
  @Get(':id')
  findOne(@Param('id') id: string): Promise<CategoryResponseDto> {
    return this.service.findOne(id);
  }

  // 创建分类（editor+）
  @ApiOperation({ summary: '创建分类（editor+）' })
  @ApiBody({ type: CreateCategoryDto })
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
  @ApiOperation({ summary: '更新分类（editor 仅可改自己创建的）' })
  @ApiParam({ name: 'id', description: '分类 ID', type: String })
  @ApiBody({ type: UpdateCategoryDto })
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
  @ApiOperation({ summary: '删除分类（editor 仅可删自己创建的）' })
  @ApiParam({ name: 'id', description: '分类 ID', type: String })
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

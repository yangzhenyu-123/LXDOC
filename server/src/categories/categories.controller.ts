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

/**
 * 分类树控制器
 * 全局前缀 /api 由 main.ts 设置，此处使用 @Controller('categories')
 * 实际路径为 /api/categories
 */
@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  // 获取分类树
  @Get()
  findAll(): Promise<CategoryResponseDto[]> {
    return this.service.findAll();
  }

  // 获取单个分类
  @Get(':id')
  findOne(@Param('id') id: string): Promise<CategoryResponseDto> {
    return this.service.findOne(id);
  }

  // 创建分类
  @Post()
  create(@Body() dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    return this.service.create(dto);
  }

  // 更新分类
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    return this.service.update(id, dto);
  }

  // 删除分类
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<void> {
    await this.service.remove(id);
  }
}

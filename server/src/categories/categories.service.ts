import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category, CategoryType } from './category.entity';
import { Document } from '../documents/document.entity';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CategoryResponseDto } from './dto/category-response.dto';

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
  ) {}

  /**
   * 查询全部分类并在内存中构建树
   * 顶层节点 parentId 为 null
   */
  async findAll(): Promise<CategoryResponseDto[]> {
    const all = await this.categoryRepo.find({
      order: { sort: 'ASC', createdAt: 'ASC' },
    });
    return this.buildTree(all);
  }

  /**
   * 查询单个分类
   */
  async findOne(id: string): Promise<CategoryResponseDto> {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException(`分类 ${id} 不存在`);
    }
    return this.toResponseDto(category, []);
  }

  /**
   * 创建分类
   * - parentId 为空：顶层分类，type 必填且必须是枚举之一
   * - parentId 提供：type 自动继承父级，dto.type 被忽略
   * - 同级（相同 parentId）下 name 不允许重复
   */
  async create(dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    let resolvedType: CategoryType;

    if (dto.parentId) {
      // 子分类：校验父级存在，type 自动继承父级
      const parent = await this.categoryRepo.findOne({
        where: { id: dto.parentId },
      });
      if (!parent) {
        throw new BadRequestException(`父级分类 ${dto.parentId} 不存在`);
      }
      // 父级 type 在顶层已校验必填，此处断言非空
      resolvedType = parent.type as CategoryType;
    } else {
      // 顶层分类：type 必填
      if (!dto.type) {
        throw new BadRequestException('顶层分类必须指定 type');
      }
      resolvedType = dto.type;
    }

    // 同级下 name 唯一
    const duplicate = await this.categoryRepo.findOne({
      where: { parentId: dto.parentId ?? null, name: dto.name },
    });
    if (duplicate) {
      throw new BadRequestException('同级下已存在同名分类');
    }

    const entity = this.categoryRepo.create({
      parentId: dto.parentId ?? null,
      name: dto.name,
      type: resolvedType,
      sort: dto.sort ?? 0,
    });
    const saved = await this.categoryRepo.save(entity);
    return this.toResponseDto(saved, []);
  }

  /**
   * 更新分类
   * - 若修改 name，校验同级不重名
   * - type 不允许通过此接口修改
   */
  async update(id: string, dto: UpdateCategoryDto): Promise<CategoryResponseDto> {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException(`分类 ${id} 不存在`);
    }

    if (dto.name !== undefined && dto.name !== category.name) {
      const duplicate = await this.categoryRepo.findOne({
        where: { parentId: category.parentId, name: dto.name },
      });
      if (duplicate && duplicate.id !== id) {
        throw new BadRequestException('同级下已存在同名分类');
      }
      category.name = dto.name;
    }

    if (dto.sort !== undefined) {
      category.sort = dto.sort;
    }

    const saved = await this.categoryRepo.save(category);
    return this.toResponseDto(saved, []);
  }

  /**
   * 删除分类
   * - 存在子节点时拒绝
   * - 存在关联文档时拒绝
   */
  async remove(id: string): Promise<void> {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException(`分类 ${id} 不存在`);
    }

    const childCount = await this.categoryRepo.count({
      where: { parentId: id },
    });
    if (childCount > 0) {
      throw new BadRequestException('该分类下存在子分类，无法删除');
    }

    const docCount = await this.documentRepo.count({
      where: { categoryId: id },
    });
    if (docCount > 0) {
      throw new BadRequestException('该分类下存在关联文档，无法删除');
    }

    await this.categoryRepo.remove(category);
  }

  /**
   * 启动时调用：若 categories 表为空则插入三个顶层分类种子数据
   */
  async seedIfEmpty(): Promise<void> {
    const count = await this.categoryRepo.count();
    if (count > 0) {
      this.logger.log(`分类表已有 ${count} 条数据，跳过种子`);
      return;
    }

    const seeds = [
      { name: '技术文档', type: CategoryType.TECH_DOC, sort: 1 },
      { name: '解决方案', type: CategoryType.SOLUTION, sort: 2 },
      { name: 'Bug 分析报告', type: CategoryType.BUG_REPORT, sort: 3 },
    ];

    for (const seed of seeds) {
      await this.categoryRepo.save(
        this.categoryRepo.create({
          parentId: null,
          name: seed.name,
          type: seed.type,
          sort: seed.sort,
        }),
      );
    }
    this.logger.log('已插入三个顶层分类种子数据');
  }

  /**
   * 在内存中将扁平列表构建为树
   */
  private buildTree(categories: Category[]): CategoryResponseDto[] {
    const map = new Map<string, CategoryResponseDto>();
    const dtos = categories.map((c) => this.toResponseDto(c, []));
    for (const dto of dtos) {
      map.set(dto.id, dto);
    }
    const roots: CategoryResponseDto[] = [];
    for (const dto of dtos) {
      if (dto.parentId && map.has(dto.parentId)) {
        map.get(dto.parentId)!.children.push(dto);
      } else {
        roots.push(dto);
      }
    }
    return roots;
  }

  /**
   * 将实体转换为响应 DTO
   */
  private toResponseDto(
    c: Category,
    children: CategoryResponseDto[],
  ): CategoryResponseDto {
    return {
      id: c.id,
      parentId: c.parentId,
      name: c.name,
      type: c.type,
      sort: c.sort,
      createdAt: c.createdAt,
      children,
    };
  }
}

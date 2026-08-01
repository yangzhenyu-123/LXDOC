import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Category, CategoryType } from './category.entity';
import { Document } from '../documents/document.entity';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CategoryResponseDto } from './dto/category-response.dto';
import { AccessControlService } from '../organizations/access-control.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../users/user.entity';

/**
 * 当前登录用户的最小结构（仅用于权限校验）
 */
interface CurrentUser {
  id: string;
  role: string;
}

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    private readonly accessControl: AccessControlService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 查询全部分类并在内存中构建树
   * 顶层节点 parentId 为 null
   * 按当前用户读权限过滤：admin 见全部；非 admin 见公共树(organizationId IS NULL)
   * + 所属组织祖先链上的组织分类
   */
  async findAll(user?: AuthUser): Promise<CategoryResponseDto[]> {
    const qb = this.categoryRepo
      .createQueryBuilder('c')
      .orderBy('c.sort', 'ASC')
      .addOrderBy('c.createdAt', 'ASC');
    if (user && user.role !== UserRole.ADMIN) {
      const ancestorIds = this.accessControl.getReadScope(user).ancestorOrgIds;
      if (ancestorIds.length > 0) {
        qb.andWhere(
          '(c.organizationId IS NULL OR c.organizationId IN (:...ancestorIds))',
          { ancestorIds },
        );
      } else {
        qb.andWhere('c.organizationId IS NULL');
      }
    }
    const all = await qb.getMany();
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
   * createdBy 记录创建者，用于后续编辑/删除权限校验
   */
  async create(
    dto: CreateCategoryDto,
    currentUser: CurrentUser,
  ): Promise<CategoryResponseDto> {
    let resolvedType: string;

    if (dto.parentId) {
      // 子分类：校验父级存在，type 自动继承父级
      const parent = await this.categoryRepo.findOne({
        where: { id: dto.parentId },
      });
      if (!parent) {
        throw new BadRequestException(`父级分类 ${dto.parentId} 不存在`);
      }
      // 父级 type 在顶层已校验必填，此处断言非空
      resolvedType = parent.type as string;
    } else {
      // 顶层分类：type 必填（任意字符串，最长 50 位）
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
      createdBy: currentUser.id,
    });
    const saved = await this.categoryRepo.save(entity);
    return this.toResponseDto(saved, []);
  }

  /**
   * 更新分类
   * - 若修改 name，校验同级不重名
   * - type 不允许通过此接口修改
   * 权限：admin 全权；editor 仅能改自己 createdBy 的分类；其他拒绝
   * 注意：seedIfEmpty 创建的顶层分类 createdBy 为 null，仅 admin 可改
   */
  async update(
    id: string,
    dto: UpdateCategoryDto,
    currentUser: CurrentUser,
  ): Promise<CategoryResponseDto> {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException(`分类 ${id} 不存在`);
    }
    this.assertCanWrite(category, currentUser);

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
   * 权限：admin 全权；editor 仅能删自己 createdBy 的分类；其他拒绝
   * 注意：seedIfEmpty 创建的顶层分类 createdBy 为 null，仅 admin 可删
   */
  async remove(id: string, currentUser: CurrentUser): Promise<void> {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException(`分类 ${id} 不存在`);
    }
    this.assertCanWrite(category, currentUser);

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
   * 校验当前用户是否可写指定分类
   * - admin 全权
   * - editor 仅当 category.createdBy === currentUser.id 时允许（createdBy 为 null 的种子分类仅 admin 可写）
   * - 其他（含 viewer）拒绝
   */
  private assertCanWrite(category: Category, currentUser: CurrentUser): void {
    if (currentUser.role === 'admin') {
      return;
    }
    if (
      currentUser.role === 'editor' &&
      category.createdBy !== null &&
      category.createdBy === currentUser.id
    ) {
      return;
    }
    throw new ForbiddenException('无权修改他人创建的分类');
  }

  /**
   * 启动时调用：
   * 1. migrateTypeColumn：将 type 列从 PG enum 迁移为 varchar(50)（幂等，已迁移则跳过）
   * 2. backfillMissingTypes：按名称回填 type 为 NULL 的已知顶层分类
   * 3. seedIfEmpty：表为空时插入 11 个顶层分类种子
   * 4. seedNewCategories：增量补种新增的默认分类（不触碰已有）
   */
  async onStartupSeed(): Promise<void> {
    await this.migrateTypeColumn();
    await this.backfillMissingTypes();
    await this.seedIfEmpty();
    await this.seedNewCategories();
  }

  /**
   * 将 categories.type 列从 PG enum 迁移为 varchar(50)
   * 幂等：已为 varchar 时跳过。使用 USING type::text 保留原值。
   */
  private async migrateTypeColumn(): Promise<void> {
    try {
      // 查询当前列的 data_type
      const rows = await this.dataSource.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'categories' AND column_name = 'type'`,
      );
      if (rows.length === 0) return; // 列不存在，交给 synchronize 建表
      const dataType = rows[0].data_type;
      if (dataType === 'USER-DEFINED' || dataType === 'ARRAY') {
        // 仍是 enum 类型，转换为 varchar
        await this.dataSource.query(
          `ALTER TABLE categories ALTER COLUMN type TYPE varchar(50) USING type::text`,
        );
        this.logger.log('已将 categories.type 列从 enum 迁移为 varchar(50)');
      }
    } catch (err) {
      this.logger.warn(`type 列迁移检查失败（可能 synchronize 已处理）：${(err as Error).message}`);
    }
  }

  /**
   * 按名称回填 type 为 NULL 的已知顶层分类
   * 覆盖 enum→varchar 转换中可能丢失 type 值的 3 个原始种子
   */
  private async backfillMissingTypes(): Promise<void> {
    const nameTypeMap: Record<string, string> = {
      技术文档: CategoryType.TECH_DOC,
      解决方案: CategoryType.SOLUTION,
      'Bug 分析报告': CategoryType.BUG_REPORT,
    };
    const topLevel = await this.categoryRepo.find({
      where: { parentId: null as unknown as string, type: null as unknown as string },
    });
    let fixed = 0;
    for (const cat of topLevel) {
      const t = nameTypeMap[cat.name];
      if (t) {
        cat.type = t;
        await this.categoryRepo.save(cat);
        fixed++;
      }
    }
    if (fixed > 0) {
      this.logger.log(`已回填 ${fixed} 个顶层分类的 type 值`);
    }
  }

  /**
   * 增量补种默认顶层分类：按名称检查，不存在则插入
   * 不触碰已有的分类（含用户自建），仅补齐新增的默认分类
   */
  private async seedNewCategories(): Promise<void> {
    const defaults = [
      { name: '新人培训', type: CategoryType.NEWCOMER, sort: 1 },
      { name: '规章制度', type: CategoryType.REGULATION, sort: 2 },
      { name: '技术文档', type: CategoryType.TECH_DOC, sort: 3 },
      { name: '解决方案', type: CategoryType.SOLUTION, sort: 4 },
      { name: '部门公共信息', type: CategoryType.DEPT_PUBLIC, sort: 5 },
      { name: '重要项目', type: CategoryType.KEY_PROJECT, sort: 6 },
      { name: '操作系统知识', type: CategoryType.OS_KNOWLEDGE, sort: 7 },
      { name: 'Bug 分析报告', type: CategoryType.BUG_REPORT, sort: 8 },
      { name: '重要bug记录', type: CategoryType.KEY_BUG, sort: 9 },
      { name: '工程问题知识库', type: CategoryType.ENG_ISSUES, sort: 10 },
      { name: '培训资料', type: CategoryType.TRAINING, sort: 11 },
    ];
    let added = 0;
    for (const d of defaults) {
      const exists = await this.categoryRepo.findOne({
        where: { parentId: null as unknown as string, name: d.name },
      });
      if (!exists) {
        await this.categoryRepo.save(
          this.categoryRepo.create({
            parentId: null,
            name: d.name,
            type: d.type,
            sort: d.sort,
          }),
        );
        added++;
      }
    }
    if (added > 0) {
      this.logger.log(`增量补种 ${added} 个默认顶层分类`);
    }
  }

  /**
   * 启动时调用：若 categories 表为空则插入 11 个顶层分类种子数据
   */
  async seedIfEmpty(): Promise<void> {
    const count = await this.categoryRepo.count();
    if (count > 0) {
      this.logger.log(`分类表已有 ${count} 条数据，跳过种子`);
      return;
    }

    const seeds = [
      { name: '新人培训', type: CategoryType.NEWCOMER, sort: 1 },
      { name: '规章制度', type: CategoryType.REGULATION, sort: 2 },
      { name: '技术文档', type: CategoryType.TECH_DOC, sort: 3 },
      { name: '解决方案', type: CategoryType.SOLUTION, sort: 4 },
      { name: '部门公共信息', type: CategoryType.DEPT_PUBLIC, sort: 5 },
      { name: '重要项目', type: CategoryType.KEY_PROJECT, sort: 6 },
      { name: '操作系统知识', type: CategoryType.OS_KNOWLEDGE, sort: 7 },
      { name: 'Bug 分析报告', type: CategoryType.BUG_REPORT, sort: 8 },
      { name: '重要bug记录', type: CategoryType.KEY_BUG, sort: 9 },
      { name: '工程问题知识库', type: CategoryType.ENG_ISSUES, sort: 10 },
      { name: '培训资料', type: CategoryType.TRAINING, sort: 11 },
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
    this.logger.log('已插入 11 个顶层分类种子数据');
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

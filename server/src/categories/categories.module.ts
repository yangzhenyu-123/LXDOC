import {
  Logger,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from './category.entity';
import { Document } from '../documents/document.entity';
import { CategoriesService } from './categories.service';
import { CategoriesController } from './categories.controller';
import { OrganizationsModule } from '../organizations/organizations.module';

/**
 * 分类模块
 * - 注册 Category / Document 两个实体的 Repository
 * - 导入 OrganizationsModule 拿 AccessControlService 做读权限过滤
 * - 启动时通过 OnApplicationBootstrap 调用 seedIfEmpty() 自动初始化顶层分类
 */
@Module({
  imports: [TypeOrmModule.forFeature([Category, Document]), OrganizationsModule],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(CategoriesModule.name);

  constructor(private readonly service: CategoriesService) {}

  async onApplicationBootstrap() {
    try {
      await this.service.onStartupSeed();
    } catch (err) {
      // 数据库未就绪时不阻断启动
      this.logger.error(
        `分类种子初始化失败：${(err as Error).message}`,
      );
    }
  }
}

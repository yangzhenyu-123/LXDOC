import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { OrganizationsModule } from '../organizations/organizations.module';

/**
 * 全文检索模块
 * 仅依赖 EntityManager（由 TypeOrmModule.forRoot 全局提供）
 * 导入 OrganizationsModule 拿 AccessControlService 做读权限过滤
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}

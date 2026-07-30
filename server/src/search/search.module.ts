import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * 全文检索模块
 * 仅依赖 EntityManager（由 TypeOrmModule.forRoot 全局提供）
 * 不需要 TypeOrmModule.forFeature，因为查询走 entityManager.query
 */
@Module({
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}

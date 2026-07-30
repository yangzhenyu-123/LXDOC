import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * 全文检索控制器
 * 全局前缀 /api 由 main.ts 设置，路由前缀 search
 * 实际路径 /api/search
 * 检索结果按当前用户读权限过滤可见范围
 */
@Controller('search')
export class SearchController {
  constructor(private readonly service: SearchService) {}

  // GET /api/search?q=keyword&page=1&pageSize=20
  @Get()
  search(
    @Query() query: SearchQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.search(
      query.q,
      user,
      query.page ?? 1,
      query.pageSize ?? 20,
    );
  }
}

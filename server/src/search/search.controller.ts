import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

/**
 * 全文检索控制器
 * 全局前缀 /api 由 main.ts 设置，路由前缀 search
 * 实际路径 /api/search
 * 检索结果按当前用户读权限过滤可见范围
 */
@ApiTags('检索 Search')
@ApiBearerAuth('access-token')
@Controller('search')
export class SearchController {
  constructor(private readonly service: SearchService) {}

  // GET /api/search?q=keyword&page=1&pageSize=20
  @ApiOperation({ summary: '全文检索（按读权限过滤）' })
  @ApiQuery({ name: 'q', required: true, description: '关键词，1~100 字符', type: String })
  @ApiQuery({ name: 'page', required: false, description: '页码，默认 1', type: Number })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数，默认 20', type: Number })
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

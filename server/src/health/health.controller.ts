import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../common/decorators/public.decorator';

/**
 * 健康检查控制器
 * 暴露 GET /health（已被全局前缀 /api 排除）
 * 返回 { status: 'ok', db: 'ok' | 'fail' }
 * 加 @Public() 提前标注，阶段三启用全局守卫后生效，无需鉴权
 */
@ApiTags('健康检查 Health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @ApiOperation({ summary: '健康检查（公开，无需鉴权）' })
  @Get()
  async check() {
    let db: 'ok' | 'fail' = 'fail';
    try {
      // 尝试执行简单查询验证数据库连接
      await this.dataSource.query('SELECT 1');
      db = 'ok';
    } catch {
      db = 'fail';
    }
    return { status: 'ok', db };
  }
}

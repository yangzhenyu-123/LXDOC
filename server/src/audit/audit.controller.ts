import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/user.entity';

/**
 * 审计日志控制器
 * GET /api/audit 分页查询审计日志，仅 admin 可访问
 * 支持按 userId / action / 时间范围筛选
 */
@Roles(UserRole.ADMIN)
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  async findAll(@Query() query: AuditQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const { items, total } = await this.auditService.findAll({
      userId: query.userId,
      action: query.action,
      startDate: query.startDate,
      endDate: query.endDate,
      page,
      pageSize,
    });
    return { items, total, page, pageSize };
  }
}

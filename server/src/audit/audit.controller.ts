import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/user.entity';
import { AuditAction } from './audit-log.entity';

/**
 * 审计日志控制器
 * GET /api/audit 分页查询审计日志，仅 admin 可访问
 * 支持按 userId / action / 时间范围筛选
 */
@ApiTags('审计 Audit')
@ApiBearerAuth('access-token')
@Roles(UserRole.ADMIN)
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @ApiOperation({ summary: '分页查询审计日志（仅 admin）' })
  @ApiQuery({ name: 'userId', required: false, description: '按操作人筛选（uuid）', type: String })
  @ApiQuery({ name: 'action', required: false, description: '按动作筛选', enum: AuditAction })
  @ApiQuery({ name: 'startDate', required: false, description: '起始时间（ISO 8601 日期字符串）', type: String })
  @ApiQuery({ name: 'endDate', required: false, description: '结束时间（ISO 8601 日期字符串）', type: String })
  @ApiQuery({ name: 'page', required: false, description: '页码，默认 1', type: Number })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数，1~100，默认 20', type: Number })
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

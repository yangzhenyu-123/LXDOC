import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { KbIngestionService } from './kb-ingestion.service';
import {
  CreateIngestionRequestDto,
  ReviewIngestionRequestDto,
  RevokeIngestionRequestDto,
} from './dto/kb-ingestion.dto';
import { IngestionRequestStatus } from './entities/kb-ingestion-request.entity';
import { UserRole } from '../users/user.entity';

/**
 * 知识库入库审核 API
 *
 * 端点：
 * - POST /requests                  ：创建入库申请（任何登录用户）
 * - GET  /requests                   ：列表查询（按 status/kbId/requesterId 筛选）
 * - GET  /requests/:id               ：申请详情（含审核意见列表）
 * - POST /requests/:id/approve       ：审核通过（仅审核人/admin）
 * - POST /requests/:id/reject        ：审核拒绝（仅审核人/admin）
 * - POST /requests/:id/revoke        ：申请人撤销（仅申请人）
 * - GET  /pending                    ：当前用户待审申请
 */
@ApiTags('知识库入库审核 KbIngestion')
@ApiBearerAuth('access-token')
@Controller('kb-ingestion')
export class KbIngestionController {
  constructor(private readonly ingestionService: KbIngestionService) {}

  @ApiOperation({ summary: '创建入库申请（KB.requireReview=true 时进入审核流）' })
  @Post('requests')
  @HttpCode(201)
  async createRequest(
    @Body() dto: CreateIngestionRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ingestionService.createRequest({
      kbId: dto.kbId,
      documentId: dto.documentId,
      requesterId: user.id,
      note: dto.note,
    });
  }

  @ApiOperation({ summary: '列出入库申请（按 status/kbId/requesterId 筛选）' })
  @Get('requests')
  findAll(@Query() query: {
    status?: IngestionRequestStatus;
    kbId?: string;
    requesterId?: string;
    page?: string;
    pageSize?: string;
  }) {
    return this.ingestionService.findAll({
      status: query.status,
      kbId: query.kbId,
      requesterId: query.requesterId,
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });
  }

  @ApiOperation({ summary: '查看入库申请详情（含审核意见列表）' })
  @Get('requests/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.ingestionService.findOne(id);
  }

  @ApiOperation({ summary: '审核通过（first-write-wins，首个通过触发入库）' })
  @Post('requests/:id/approve')
  @HttpCode(200)
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewIngestionRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ingestionService.approve({
      requestId: id,
      reviewerId: user.id,
      reviewerRole: user.role as UserRole,
      comment: dto.comment,
    });
  }

  @ApiOperation({ summary: '审核拒绝（仅记录意见，不强制终结申请）' })
  @Post('requests/:id/reject')
  @HttpCode(200)
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewIngestionRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ingestionService.reject({
      requestId: id,
      reviewerId: user.id,
      reviewerRole: user.role as UserRole,
      comment: dto.comment,
    });
  }

  @ApiOperation({ summary: '申请人撤销入库申请（仅 pending 可撤销）' })
  @Post('requests/:id/revoke')
  @HttpCode(200)
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeIngestionRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ingestionService.revoke({
      requestId: id,
      requesterId: user.id,
      reason: dto.reason,
    });
  }

  @ApiOperation({ summary: '当前用户待审申请（admin 看全部，组织 admin 看管理范围内）' })
  @Get('pending')
  async findPending(@CurrentUser() user: AuthUser) {
    const role = user.role as UserRole;
    const manageableOrgIds =
      role === UserRole.ADMIN
        ? []
        : await this.ingestionService.getManageableOrgIds(user.id);
    return this.ingestionService.findPendingForReviewer(
      user.id,
      role,
      manageableOrgIds,
    );
  }
}

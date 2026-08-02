import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { NotificationService } from './notification.service';

/**
 * 站内通知 API
 *
 * 所有端点仅处理当前登录用户自己的通知（按 userId 隔离）。
 */
@ApiTags('通知 Notification')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @ApiOperation({ summary: '列出当前用户的通知（未读优先，按 createdAt DESC）' })
  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query('onlyUnread') onlyUnread?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.notificationService.findAllForUser(user.id, {
      onlyUnread: onlyUnread === 'true',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @ApiOperation({ summary: '未读通知数量' })
  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notificationService.countUnread(user.id);
  }

  @ApiOperation({ summary: '标记单条通知已读' })
  @Post(':id/read')
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ success: boolean }> {
    const ok = await this.notificationService.markRead(id, user.id);
    return { success: ok };
  }

  @ApiOperation({ summary: '全部通知标记已读' })
  @Post('read-all')
  async markAllRead(@CurrentUser() user: AuthUser): Promise<{ affected: number }> {
    const affected = await this.notificationService.markAllRead(user.id);
    return { affected };
  }
}

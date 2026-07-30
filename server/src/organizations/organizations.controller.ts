import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { AccessControlService } from './access-control.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { AddMemberDto, UpdateMemberDto } from './dto/member.dto';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { AuditAction } from '../audit/audit-log.entity';
import { UserRole } from '../users/user.entity';

/**
 * 组织管理控制器
 * 全局前缀 /api，路由前缀 organizations
 *
 * - GET    /api/organizations                  组织树（扁平，前端构建树，登录可读）
 * - POST   /api/organizations                  新建节点（admin 或父节点 admin）
 * - PATCH  /api/organizations/:id              改名/排序（admin 或该节点 admin）
 * - DELETE /api/organizations/:id              删除节点（admin 或该节点 admin，无子节点无文档）
 * - GET    /api/organizations/:id/members      成员列表（admin 或该节点 admin）
 * - POST   /api/organizations/:id/members      添加成员（admin 或该节点 admin）
 * - PATCH  /api/organizations/:id/members/:userId  改成员角色
 * - DELETE /api/organizations/:id/members/:userId  移除成员
 */
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly service: OrganizationsService,
    private readonly accessControl: AccessControlService,
  ) {}

  // 组织树（扁平列表，前端自行构建树）—— 登录可读
  @Get()
  findAll() {
    return this.service.findAll();
  }

  // 新建节点：顶层部门仅 admin；子节点需对父节点有管理权
  @Post()
  @Audit(AuditAction.PERMISSION_CHANGE, 'organization')
  async create(
    @Body() dto: CreateOrganizationDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (dto.parentId) {
      const ok = await this.accessControl.canManageOrg(user, dto.parentId);
      if (!ok) {
        throw new ForbiddenException('无权在该父节点下创建子节点');
      }
    } else if (user.role !== UserRole.ADMIN) {
      // 顶层部门创建仅限全局 admin
      throw new ForbiddenException('仅管理员可创建顶层部门');
    }
    return this.service.create({
      name: dto.name,
      type: dto.type,
      parentId: dto.parentId ?? null,
      sort: dto.sort,
    });
  }

  // 改名/排序
  @Patch(':id')
  @Audit(AuditAction.PERMISSION_CHANGE, 'organization')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateOrganizationDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertCanManage(user, id);
    return this.service.update(id, dto);
  }

  // 删除节点
  @Delete(':id')
  @Audit(AuditAction.PERMISSION_CHANGE, 'organization')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.assertCanManage(user, id);
    await this.service.remove(id);
  }

  // 成员列表
  @Get(':id/members')
  async listMembers(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.assertCanManage(user, id);
    return this.service.listMembersWithUser(id);
  }

  // 添加成员
  @Post(':id/members')
  @Audit(AuditAction.PERMISSION_CHANGE, 'organization_member')
  async addMember(
    @Param('id') id: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertCanManage(user, id);
    const row = await this.service.addMember(id, dto.userId, dto.role);
    this.accessControl.invalidateUserCache(dto.userId);
    return row;
  }

  // 改成员角色
  @Patch(':id/members/:userId')
  @Audit(AuditAction.PERMISSION_CHANGE, 'organization_member')
  async updateMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertCanManage(user, id);
    const row = await this.service.updateMemberRole(id, userId, dto.role);
    this.accessControl.invalidateUserCache(userId);
    return row;
  }

  // 移除成员
  @Delete(':id/members/:userId')
  @Audit(AuditAction.PERMISSION_CHANGE, 'organization_member')
  async removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertCanManage(user, id);
    await this.service.removeMember(id, userId);
    this.accessControl.invalidateUserCache(userId);
  }

  /**
   * 校验当前用户对节点有管理权，否则 403
   */
  private async assertCanManage(user: AuthUser, orgId: string): Promise<void> {
    const ok = await this.accessControl.canManageOrg(user, orgId);
    if (!ok) {
      throw new ForbiddenException('无权管理该组织节点');
    }
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { AuditAction } from '../audit/audit-log.entity';
import { UserRole } from '../users/user.entity';

/**
 * 文档控制器
 * 全局前缀 /api 由 main.ts 设置
 * 路由：
 * - GET    /api/documents/recent             最近更新的 N 篇文档（登录可读）
 * - GET    /api/documents/:id                获取单个文档（登录可读）
 * - PUT    /api/documents/:id                更新文档（创建版本快照，editor+，editor 仅可改自己创建的）
 * - DELETE /api/documents/:id                删除文档（editor+，editor 仅可删自己创建的）
 * - GET    /api/documents/:id/versions       列出版本（登录可读）
 * - GET    /api/documents/:id/versions/:v    获取某版本内容（登录可读）
 * - POST   /api/documents/:id/rollback/:v    回滚到某版本（editor+，editor 仅可回滚自己创建的）
 * - GET    /api/categories/:id/documents     列出分类下文档（登录可读）
 * - GET    /api/documents/:id/preview        获取 docx/odt 预览片段（登录可读）
 * 类上不加 @Roles：读操作所有登录用户（含 viewer）可访问，写操作在方法上单独标注
 */
@Controller()
export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  // 最近更新的文档（不含 content）。注意：必须声明在 documents/:id 之前，否则 'recent' 会被 :id 匹配
  @Get('documents/recent')
  findRecent(@Query('limit') limit?: string) {
    const n = limit !== undefined ? Number(limit) : 10;
    return this.service.findRecent(Number.isFinite(n) ? n : 10);
  }

  // 获取单个文档（含 content）
  @Get('documents/:id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  // 获取 docx/odt 文档的 HTML 预览片段
  @Get('documents/:id/preview')
  async getPreview(@Param('id') id: string) {
    const html = await this.service.getPreviewHtml(id);
    return { html };
  }

  // 更新文档（editor+；editor 仅可改自己 createdBy 的文档，由 service 校验）
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Audit(AuditAction.DOCUMENT_UPDATE, 'document')
  @Put('documents/:id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, dto, user);
  }

  // 删除文档（editor+；editor 仅可删自己 createdBy 的文档，由 service 校验）
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Audit(AuditAction.DOCUMENT_DELETE, 'document')
  @Delete('documents/:id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.service.remove(id, user);
  }

  // 列出文档所有版本（按 version DESC）
  @Get('documents/:id/versions')
  listVersions(@Param('id') id: string) {
    return this.service.listVersions(id);
  }

  // 获取指定版本内容
  @Get('documents/:id/versions/:v')
  getVersion(
    @Param('id') id: string,
    @Param('v') v: string,
  ) {
    const version = Number(v);
    if (Number.isNaN(version) || !Number.isInteger(version)) {
      throw new BadRequestException(`无效的版本号：${v}`);
    }
    return this.service.getVersion(id, version);
  }

  // 回滚到指定版本（editor+；editor 仅可回滚自己 createdBy 的文档，由 service 校验）
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Audit(AuditAction.DOCUMENT_UPDATE, 'document')
  @Post('documents/:id/rollback/:v')
  rollback(
    @Param('id') id: string,
    @Param('v') v: string,
    @CurrentUser() user: AuthUser,
  ) {
    const version = Number(v);
    if (Number.isNaN(version) || !Number.isInteger(version)) {
      throw new BadRequestException(`无效的版本号：${v}`);
    }
    return this.service.rollback(id, version, user);
  }

  // 列出某分类下所有文档
  // 路由放在 categories 前缀下，由 documents controller 处理
  @Get('categories/:id/documents')
  listByCategory(
    @Param('id') id: string,
    @Query('includeChildren') includeChildren?: string,
  ) {
    const include =
      includeChildren === 'true' || includeChildren === '1';
    return this.service.listByCategory(id, include);
  }
}

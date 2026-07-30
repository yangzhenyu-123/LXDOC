import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { AuditAction } from '../audit/audit-log.entity';
import { UserRole } from '../users/user.entity';
import { OnlyOfficeService, OnlyOfficeCallbackPayload } from './onlyoffice.service';

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
  constructor(
    private readonly service: DocumentsService,
    private readonly onlyOffice: OnlyOfficeService,
  ) {}

  // 最近更新的文档（不含 content）。注意：必须声明在 documents/:id 之前，否则 'recent' 会被 :id 匹配
  @Get('documents/recent')
  findRecent(@Query('limit') limit?: string, @CurrentUser() user?: AuthUser) {
    const n = limit !== undefined ? Number(limit) : 10;
    return this.service.findRecent(Number.isFinite(n) ? n : 10, user!);
  }

  // 获取单个文档（含 content）
  @Get('documents/:id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.service.findOne(id, user);
  }

  // 获取 docx/odt 文档的 HTML 预览片段
  @Get('documents/:id/preview')
  async getPreview(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const html = await this.service.getPreviewHtml(id, user);
    return { html };
  }

  // 获取 PDF 版式保真 HTML（pdf2htmlEX 生成）
  @Get('documents/:id/pdf-html')
  async getPdfHtml(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const html = await this.service.getPdfHtml(id, user);
    return { html };
  }

  // 将 PDF 转为可编辑的新 markdown 文档（需写权限）
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Audit(AuditAction.DOCUMENT_CREATE, 'document')
  @Post('documents/:id/convert-to-editable')
  convertToEditable(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.convertToEditable(id, user);
  }

  // 获取 OnlyOffice 前端初始化 config
  // - mode=view：读权限即可
  // - mode=edit：需写权限，由 OnlyOfficeService 内部校验
  @Get('documents/:id/onlyoffice/config')
  getOnlyOfficeConfig(
    @Param('id') id: string,
    @Query('mode') mode: 'edit' | 'view' | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.onlyOffice.buildConfig(id, user, mode);
  }

  // OnlyOffice 保存回调
  // @Public：OnlyOffice 容器以 JWT payload.token 形式签名，不走用户 JwtAuthGuard
  // 返回 {"error": 0|1}，OnlyOffice 约定 0 表示成功
  @Public()
  @HttpCode(200)
  @Post('documents/:id/onlyoffice/callback')
  async onlyOfficeCallback(
    @Param('id') id: string,
    @Body() payload: OnlyOfficeCallbackPayload,
    @Req() _req: unknown,
  ): Promise<{ error: 0 | 1 }> {
    return this.onlyOffice.handleCallback(id, payload);
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
  listVersions(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.service.listVersions(id, user);
  }

  // 获取指定版本内容
  @Get('documents/:id/versions/:v')
  getVersion(
    @Param('id') id: string,
    @Param('v') v: string,
    @CurrentUser() user: AuthUser,
  ) {
    const version = Number(v);
    if (Number.isNaN(version) || !Number.isInteger(version)) {
      throw new BadRequestException(`无效的版本号：${v}`);
    }
    return this.service.getVersion(id, version, user);
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
    @CurrentUser() user: AuthUser,
    @Query('includeChildren') includeChildren?: string,
  ) {
    const include =
      includeChildren === 'true' || includeChildren === '1';
    return this.service.listByCategory(id, user, include);
  }
}

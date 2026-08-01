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
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
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
@ApiTags('文档 Documents')
@ApiBearerAuth('access-token')
@Controller()
export class DocumentsController {
  constructor(
    private readonly service: DocumentsService,
    private readonly onlyOffice: OnlyOfficeService,
  ) {}

  // 最近更新的文档（不含 content）。注意：必须声明在 documents/:id 之前，否则 'recent' 会被 :id 匹配
  @ApiOperation({ summary: '获取最近更新的文档' })
  @ApiQuery({ name: 'limit', required: false, description: '返回条数，默认 10', type: Number })
  @Get('documents/recent')
  findRecent(@Query('limit') limit?: string, @CurrentUser() user?: AuthUser) {
    const n = limit !== undefined ? Number(limit) : 10;
    return this.service.findRecent(Number.isFinite(n) ? n : 10, user!);
  }

  // 获取单个文档（含 content）
  @ApiOperation({ summary: '获取单个文档（含 content）' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @Get('documents/:id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.service.findOne(id, user);
  }

  // 获取 docx/odt 文档的 HTML 预览片段
  @ApiOperation({ summary: '获取 docx/odt 文档 HTML 预览片段' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @Get('documents/:id/preview')
  async getPreview(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const html = await this.service.getPreviewHtml(id, user);
    return { html };
  }

  // 获取 PDF 版式保真 HTML（pdf2htmlEX 生成）
  @ApiOperation({ summary: '获取 PDF 版式保真 HTML' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @Get('documents/:id/pdf-html')
  async getPdfHtml(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const html = await this.service.getPdfHtml(id, user);
    return { html };
  }

  // 获取 kkFileView 统一预览 URL（前端 iframe 嵌入）
  @ApiOperation({ summary: '获取 kkFileView 统一预览 URL' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @Get('documents/:id/kkview')
  async getKkViewUrl(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ url: string }> {
    const url = await this.service.getKkViewUrl(id, user);
    return { url };
  }

  // 将 PDF 转为可编辑的新 markdown 文档（需写权限）
  @ApiOperation({ summary: '将 PDF 转为可编辑的新 markdown 文档（editor+）' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Audit(AuditAction.DOCUMENT_CREATE, 'document')
  @Post('documents/:id/convert-to-editable')
  convertToEditable(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.convertToEditable(id, user);
  }

  // AI 总结：基于原文档文本调用 GLM5.2 生成新的 Markdown 总结文档
  // 生成的新文档继承原文档归属空间，采用 Docsify 风格渲染（/read/:docId）
  // 安全：summarize 会创建新文档并消耗 LLM 资源，需 editor+ 权限（与其它文档创建接口一致）
  @ApiOperation({ summary: 'AI 总结文档生成新 Markdown（editor+）' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Audit(AuditAction.DOCUMENT_CREATE, 'document')
  @Post('documents/:id/summarize')
  summarize(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.summarize(id, user);
  }

  // 获取 OnlyOffice 前端初始化 config
  // - mode=view：读权限即可
  // - mode=edit：需写权限，由 OnlyOfficeService 内部校验
  @ApiOperation({ summary: '获取 OnlyOffice 前端初始化 config' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @ApiQuery({ name: 'mode', required: false, description: '编辑模式：edit 或 view', enum: ['edit', 'view'] })
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
  @ApiOperation({ summary: 'OnlyOffice 保存回调（公开，无需鉴权）' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @ApiBody({
    description: 'OnlyOffice 回调 payload（由 OnlyOffice 容器签发 JWT，含 status/key/url 等字段）',
    schema: { type: 'object' },
  })
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
  @ApiOperation({ summary: '更新文档（创建版本快照，editor+）' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @ApiBody({ type: UpdateDocumentDto })
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
  @ApiOperation({ summary: '删除文档（editor+）' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
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
  @ApiOperation({ summary: '列出文档所有版本' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @Get('documents/:id/versions')
  listVersions(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.service.listVersions(id, user);
  }

  // 获取指定版本内容
  @ApiOperation({ summary: '获取指定版本内容' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @ApiParam({ name: 'v', description: '版本号', type: Number })
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
  @ApiOperation({ summary: '回滚到指定版本（editor+）' })
  @ApiParam({ name: 'id', description: '文档 ID', type: String })
  @ApiParam({ name: 'v', description: '版本号', type: Number })
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
  @ApiOperation({ summary: '列出分类下文档' })
  @ApiParam({ name: 'id', description: '分类 ID', type: String })
  @ApiQuery({ name: 'includeChildren', required: false, description: '是否包含子分类文档：true 或 1', type: String })
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

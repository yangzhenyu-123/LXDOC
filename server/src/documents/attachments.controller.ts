import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { uploadConfig } from '../config/upload.config';
import { AttachmentsService } from './attachments.service';
import { FilesService } from '../files/files.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { UserRole } from '../users/user.entity';

type SendFileResponse = any;

/**
 * 文档附件控制器
 * 全局前缀 /api，路径前缀 /api/documents/:docId/attachments
 *
 * 权限：附件权限继承主文档
 * - 读操作（list / getKkViewUrl）：需对主文档读权限
 * - 写操作（uploadFile / linkDocument / remove / updateSort）：需对主文档写权限（editor+）
 * - 下载（download）：@Public，由 query token 校验（token 按主文档 id 签发）
 */
@ApiTags('文档附件 Attachments')
@ApiBearerAuth('access-token')
@Controller('documents/:docId/attachments')
export class AttachmentsController {
  constructor(
    private readonly service: AttachmentsService,
    private readonly filesService: FilesService,
  ) {}

  /** 列出主文档所有附件（读权限） */
  @ApiOperation({ summary: '列出文档的所有附件' })
  @Get()
  async list(@Param('docId') docId: string, @CurrentUser() user: AuthUser) {
    return this.service.listByDoc(docId, user);
  }

  /** 上传附件文件（写权限，editor+） */
  @ApiOperation({ summary: '上传附件文件（file 类型）' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'file 为附件文件（字段名 file，支持压缩包/源码/图片/office 全格式）；sort 可选',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        sort: { type: 'integer', description: '排序值（可选）' },
      },
      required: ['file'],
    },
  })
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Post('file')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: uploadConfig.maxDocFileSize },
    }),
  )
  async uploadFile(
    @Param('docId') docId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('sort') sort: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('未提供附件文件');
    const sortNum = sort ? Number(sort) : 0;
    return this.service.uploadFile(docId, file, user, sortNum);
  }

  /** 把另一个文档引用为集合成员（写权限） */
  @ApiOperation({ summary: '把另一文档引用为文档集成员（document 类型）' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        linkedDocumentId: { type: 'string', format: 'uuid' },
        sort: { type: 'integer', description: '排序值（可选）' },
      },
      required: ['linkedDocumentId'],
    },
  })
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Post('document')
  async linkDocument(
    @Param('docId') docId: string,
    @Body('linkedDocumentId') linkedDocumentId: string,
    @Body('sort') sort: number | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!linkedDocumentId) throw new BadRequestException('缺少 linkedDocumentId');
    return this.service.linkDocument(docId, linkedDocumentId, user, sort ?? 0);
  }

  /** 删除附件 / 移出集合（写权限） */
  @ApiOperation({ summary: '删除附件 / 移出集合' })
  @ApiParam({ name: 'attachId', type: String })
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Delete(':attachId')
  async remove(
    @Param('docId') docId: string,
    @Param('attachId') attachId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.remove(attachId, user);
    return { success: true };
  }

  /** 更新附件排序（写权限） */
  @ApiOperation({ summary: '更新附件排序' })
  @ApiParam({ name: 'attachId', type: String })
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @Put(':attachId/sort')
  async updateSort(
    @Param('docId') docId: string,
    @Param('attachId') attachId: string,
    @Body('sort') sort: number,
    @CurrentUser() user: AuthUser,
  ) {
    await this.service.updateSort(attachId, Number(sort), user);
    return { success: true };
  }

  /** 获取附件的 kkFileView 预览 URL（仅 file 类型，读权限） */
  @ApiOperation({ summary: '获取附件的 kkFileView 预览 URL' })
  @ApiParam({ name: 'attachId', type: String })
  @Get(':attachId/kkview')
  async getKkViewUrl(
    @Param('docId') docId: string,
    @Param('attachId') attachId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ url: string }> {
    const url = await this.service.getAttachmentKkViewUrl(attachId, user);
    return { url };
  }

  /**
   * 下载附件文件（仅 file 类型）
   * @Public：跳过 JWT，由 query token 校验（token 按主文档 id 签发）
   * 供 kkFileView 容器拉取附件文件
   */
  @ApiOperation({ summary: '下载附件文件（公开，校验 token）' })
  @ApiParam({ name: 'docId', type: String })
  @ApiParam({ name: 'attachId', type: String })
  @ApiQuery({ name: 'token', required: true, description: '主文档的短期文件 token', type: String })
  @Public()
  @Get(':attachId/download')
  async download(
    @Param('docId') docId: string,
    @Param('attachId') attachId: string,
    @Query('token') token: string | undefined,
    @Res() res: SendFileResponse,
  ): Promise<void> {
    if (!token) throw new UnauthorizedException('缺少文件 token');
    this.filesService.verifyFileToken(token, docId);
    const absPath = await this.service.getAttachmentAbsPath(attachId);
    res.sendFile(absPath);
  }
}

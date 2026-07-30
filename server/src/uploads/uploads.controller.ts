import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as path from 'node:path';
import { UploadsService, ALLOWED_EXTENSIONS } from './uploads.service';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { UploadImageDto } from './dto/upload-image.dto';
import { uploadConfig } from '../config/upload.config';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { AuditAction } from '../audit/audit-log.entity';
import { UserRole } from '../users/user.entity';

/**
 * 文件上传控制器
 * 全局前缀 /api，实际路径为 /api/uploads 与 /api/uploads/image
 * 上传需 editor+ 权限（admin / editor）
 */
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('uploads')
export class UploadsController {
  constructor(private readonly service: UploadsService) {}

  /**
   * POST /api/uploads
   * body: categoryId (uuid)
   * file: multipart file 字段名 'file'
   * 校验扩展名白名单后调用 service.ingest，记录 createdBy
   * 返回 { id, title, format, version, categoryId }
   */
  @Post()
  @Audit(AuditAction.DOCUMENT_CREATE, 'document')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) {
      throw new BadRequestException('未提供上传文件');
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new BadRequestException(
        `不支持的文件扩展名 ${ext}，允许：${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }
    const doc = await this.service.ingest(file, dto.categoryId, user.id);
    return {
      id: doc.id,
      title: doc.title,
      format: doc.format,
      version: doc.version,
      categoryId: doc.categoryId,
    };
  }

  /**
   * POST /api/uploads/image
   * body: docId (uuid, 可空)
   * file: multipart file 字段名 'file'
   * 仅接受图片 MIME，保存到 images/<docId|user.id>/<uuid>.<ext>
   * 返回 { url, filename }
   */
  @Post('image')
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadImageDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) {
      throw new BadRequestException('未提供上传图片');
    }
    if (!uploadConfig.allowedImageMimes.includes(file.mimetype)) {
      throw new BadRequestException('仅支持 PNG/JPEG/GIF/WEBP 图片');
    }
    // docId 为空时用当前用户 id 作为临时 scope（替代 'temp'），便于按用户隔离临时图片
    return this.service.saveImage(file, dto.docId ?? user.id);
  }
}

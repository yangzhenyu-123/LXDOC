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

/**
 * 文件上传控制器
 * 全局前缀 /api，实际路径为 /api/uploads 与 /api/uploads/image
 */
@Controller('uploads')
export class UploadsController {
  constructor(private readonly service: UploadsService) {}

  /**
   * POST /api/uploads
   * body: categoryId (uuid)
   * file: multipart file 字段名 'file'
   * 校验扩展名白名单后调用 service.ingest
   * 返回 { id, title, format, version, categoryId }
   */
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadDocumentDto,
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
    const doc = await this.service.ingest(file, dto.categoryId);
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
   * 仅接受图片 MIME，保存到 images/<docId|temp>/<uuid>.<ext>
   * 返回 { url, filename }
   */
  @Post('image')
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadImageDto,
  ) {
    if (!file) {
      throw new BadRequestException('未提供上传图片');
    }
    if (!uploadConfig.allowedImageMimes.includes(file.mimetype)) {
      throw new BadRequestException('仅支持 PNG/JPEG/GIF/WEBP 图片');
    }
    return this.service.saveImage(file, dto.docId ?? null);
  }
}

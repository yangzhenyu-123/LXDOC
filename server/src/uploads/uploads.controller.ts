import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import * as path from 'node:path';
import { IsArray, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { UploadsService, ALLOWED_EXTENSIONS } from './uploads.service';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { UploadImageDto } from './dto/upload-image.dto';
import { uploadConfig } from '../config/upload.config';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { AuditAction } from '../audit/audit-log.entity';
import { UserRole } from '../users/user.entity';
import { DocumentOwnerType } from '../documents/document.entity';

/**
 * 创建文档集 DTO（无文件，纯引用组合）
 */
class CreateCollectionDto {
  @ApiProperty({ description: '集合标题' })
  @IsString()
  title: string;

  @ApiProperty({ description: '所属分类 id' })
  @IsUUID()
  categoryId: string;

  @ApiProperty({ description: '成员文档 id 列表', type: [String] })
  @IsArray()
  @IsUUID('all', { each: true })
  memberDocIds: string[];

  @ApiProperty({ description: '文档归属类型', enum: DocumentOwnerType, default: 'personal' })
  @IsOptional()
  @IsEnum(DocumentOwnerType)
  ownerType?: DocumentOwnerType;

  @ApiProperty({ description: '归属组织 id（ownerType 非 personal 时必填）' })
  @IsOptional()
  @IsUUID()
  ownerId?: string;
}

/**
 * 文件上传控制器
 * 全局前缀 /api，实际路径为 /api/uploads 与 /api/uploads/image
 * 上传需 editor+ 权限（admin / editor）
 */
@ApiTags('上传 Uploads')
@ApiBearerAuth('access-token')
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
  @ApiOperation({ summary: '上传文档（multipart file 字段 file）' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description:
      'categoryId 为分类 ID；file 为上传文件（字段名必须为 file，支持 .md/.txt/.docx/.odt/.pdf 及 office 全格式）',
    schema: {
      type: 'object',
      properties: {
        categoryId: { type: 'string', format: 'uuid', description: '分类 ID' },
        ownerType: {
          type: 'string',
          enum: ['personal', 'group', 'department'],
          description: '文档归属类型（可选，默认 personal）',
        },
        ownerId: { type: 'string', format: 'uuid', description: '组织节点 ID（ownerType 非 personal 时必填）' },
        isCollection: { type: 'boolean', description: '是否标记为文档集（默认 false）' },
        file: { type: 'string', format: 'binary', description: '上传文件' },
      },
      required: ['categoryId', 'file'],
    },
  })
  @Post()
  @Audit(AuditAction.DOCUMENT_CREATE, 'document')
  @UseInterceptors(
    FileInterceptor('file', {
      // 限制单文件大小，防止超大上传耗尽内存（multer 默认 memory storage 缓冲到内存）
      limits: { fileSize: uploadConfig.maxDocFileSize },
    }),
  )
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
    const doc = await this.service.ingest(
      file,
      dto.categoryId,
      user,
      dto.ownerType,
      dto.ownerId,
      dto.isCollection,
    );
    return {
      id: doc.id,
      title: doc.title,
      format: doc.format,
      version: doc.version,
      categoryId: doc.categoryId,
      ownerType: doc.ownerType,
      ownerId: doc.ownerId,
      isCollection: doc.isCollection,
    };
  }

  /**
   * POST /api/uploads/collection
   * 创建文档集（无文件，主文档 isCollection=true，引用成员文档）
   * body: { title, categoryId, memberDocIds[], ownerType?, ownerId? }
   */
  @ApiOperation({ summary: '创建文档集（无文件，引用成员文档）' })
  @ApiBody({ type: CreateCollectionDto })
  @Post('collection')
  @Audit(AuditAction.DOCUMENT_CREATE, 'document')
  async createCollection(
    @Body() dto: CreateCollectionDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!dto.memberDocIds?.length) {
      throw new BadRequestException('至少需要一个成员文档');
    }
    const doc = await this.service.createCollection(
      dto.title,
      dto.categoryId,
      dto.memberDocIds,
      user,
      dto.ownerType,
      dto.ownerId,
    );
    return {
      id: doc.id,
      title: doc.title,
      format: doc.format,
      version: doc.version,
      categoryId: doc.categoryId,
      ownerType: doc.ownerType,
      ownerId: doc.ownerId,
      isCollection: doc.isCollection,
    };
  }

  /**
   * POST /api/uploads/image
   * body: docId (uuid, 可空)
   * file: multipart file 字段名 'file'
   * 仅接受图片 MIME，保存到 images/<docId|user.id>/<uuid>.<ext>
   * 返回 { url, filename }
   */
  @ApiOperation({ summary: '上传图片（multipart file 字段 file）' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description:
      'docId 为关联文档 ID（可空，空时按用户隔离临时图片）；file 为图片文件（字段名 file，仅 PNG/JPEG/GIF/WEBP）',
    schema: {
      type: 'object',
      properties: {
        docId: { type: 'string', format: 'uuid', description: '关联文档 ID（可选）', nullable: true },
        file: { type: 'string', format: 'binary', description: '图片文件' },
      },
      required: ['file'],
    },
  })
  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', {
      // 图片单文件大小限制
      limits: { fileSize: uploadConfig.maxImageFileSize },
    }),
  )
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

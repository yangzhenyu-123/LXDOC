import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../documents/document.entity';
import { DocumentVersion } from '../documents/document-version.entity';
import { Category } from '../categories/category.entity';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { TextParser } from './parsers/text.parser';
import { PandocParser } from './parsers/pandoc.parser';
import { PdfParser } from './parsers/pdf.parser';

/**
 * 文件上传模块
 * - 注册 Document / DocumentVersion / Category 三个实体的 Repository
 * - 引入 OrganizationsModule 以使用 AccessControlService 校验上传归属权限
 * - 注册 UploadsService 与多个 FileParser（TextParser / PandocParser / PdfParser）
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Document, DocumentVersion, Category]),
    OrganizationsModule,
  ],
  controllers: [UploadsController],
  providers: [UploadsService, TextParser, PandocParser, PdfParser],
  exports: [UploadsService],
})
export class UploadsModule {}

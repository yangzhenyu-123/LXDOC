import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { Document } from './document.entity';
import { DocumentVersion } from './document-version.entity';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { PdfToolsService } from './pdf-tools.service';
import { OnlyOfficeService } from './onlyoffice.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { FilesModule } from '../files/files.module';
import { LlmModule } from '../llm/llm.module';
import { onlyofficeConfig } from '../config/onlyoffice.config';

/**
 * 文档模块
 * - 注册 Document / DocumentVersion 两个实体的 Repository
 * - 导入 OrganizationsModule 拿 AccessControlService 做读写权限校验
 * - 导入 FilesModule 拿 FilesService 在预览 HTML 中签发图片访问 token
 * - 导入 LlmModule 拿 LlmService 做 AI 总结（GLM5.2）
 * - 注册 JwtModule（OnlyOfficeService 签发/校验 config 与回调 JWT）
 * - 提供文档 CRUD、版本查询、回滚、按分类列表、PDF/OnlyOffice 集成、AI 总结等接口
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Document, DocumentVersion]),
    OrganizationsModule,
    FilesModule,
    LlmModule,
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: onlyofficeConfig.jwtSecret,
      }),
    }),
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, PdfToolsService, OnlyOfficeService],
  exports: [DocumentsService],
})
export class DocumentsModule {}

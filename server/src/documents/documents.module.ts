import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from './document.entity';
import { DocumentVersion } from './document-version.entity';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

/**
 * 文档模块
 * - 注册 Document / DocumentVersion 两个实体的 Repository
 * - 提供文档 CRUD、版本查询、回滚、按分类列表等接口
 */
@Module({
  imports: [TypeOrmModule.forFeature([Document, DocumentVersion])],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}

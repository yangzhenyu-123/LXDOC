import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../documents/document.entity';
import { OrganizationsModule } from '../organizations/organizations.module';
import { authConfig } from '../config/auth.config';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

/**
 * 文件访问模块
 * - 注册 Document 实体 Repository（FilesService 查文档原文件路径）
 * - 注册 JwtModule（签发/校验文件 token，复用 authConfig.jwtSecret）
 * - 导入 OrganizationsModule 拿 AccessControlService 做读权限校验
 * - 导出 FilesService 供 DocumentsService 在预览 HTML 中签发图片 token
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Document]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: () => ({
        secret: authConfig.jwtSecret,
      }),
    }),
    OrganizationsModule,
  ],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}

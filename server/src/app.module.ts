import {
  Module,
  OnApplicationBootstrap,
  Logger,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { InjectEntityManager, TypeOrmModule } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { databaseConfig } from './config/database.config';
import { HealthModule } from './health/health.module';
import { CategoriesModule } from './categories/categories.module';
import { UploadsModule } from './uploads/uploads.module';
import { DocumentsModule } from './documents/documents.module';
import { FilesModule } from './files/files.module';
import { SearchModule } from './search/search.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { LlmModule } from './llm/llm.module';
import { AuditInterceptor } from './audit/audit.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

@Module({
  imports: [
    // 全局加载 .env 环境变量
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // 异步注入 TypeORM 配置，从 env 读取连接参数
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: databaseConfig,
    }),
    HealthModule,
    CategoriesModule,
    // 文件上传与多格式解析模块
    UploadsModule,
    // 文档 CRUD + 版本管理模块
    DocumentsModule,
    // 静态文件鉴权访问模块（签名 URL：原文件 / 图片）
    FilesModule,
    // 全文检索模块（依赖 pg_trgm + GIN trgm 索引）
    SearchModule,
    // 用户与认证模块
    UsersModule,
    // 认证模块（JWT 双 token）
    AuthModule,
    // 审计日志模块
    AuditModule,
    // 组织层级权限模块（部门/组树 + 成员授权）
    OrganizationsModule,
    // LLM 接入模块（Provider 抽象 + GLM5.2 实现 + 健康检查，业务模块按需注入）
    LlmModule,
  ],
  providers: [
    // 全局守卫：JwtAuthGuard 先执行（认证），RolesGuard 后执行（授权）
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // 全局拦截器：AuditInterceptor 在守卫之后、handler 成功返回后记录审计日志
    // 依赖 AuditService（由 AuditModule 导出），AuditModule 已在 imports 中
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule implements OnApplicationBootstrap {
  private readonly logger = new Logger('AppModule');

  constructor(
    @InjectEntityManager() private readonly entityManager: EntityManager,
  ) {}

  /**
   * 应用启动后执行：
   * 1. 启用 pg_trgm 扩展（用于 trigram 模糊匹配）
   * 2. 在 documents 表上创建 title / content 的 GIN trigram 索引
   * 3. 迁移 documents.user_id → documents.created_by（兼容已有数据）
   * 4. 为 categories 表显式 ADD created_by 列（synchronize 会自动建，保险起见）
   * synchronize 已完成建表，此处可安全执行
   * 每条 SQL 独立 try/catch，已存在则跳过，连接失败时不影响服务启动
   */
  async onApplicationBootstrap() {
    try {
      await this.entityManager.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
      this.logger.log('pg_trgm 扩展已就绪');
    } catch (err) {
      this.logger.error(
        `创建 pg_trgm 扩展失败：${(err as Error).message}`,
      );
    }

    try {
      await this.entityManager.query(
        'CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING GIN (title gin_trgm_ops);',
      );
      await this.entityManager.query(
        'CREATE INDEX IF NOT EXISTS idx_documents_content_trgm ON documents USING GIN (content gin_trgm_ops);',
      );
      this.logger.log('documents trigram GIN 索引已就绪');
    } catch (err) {
      this.logger.error(
        `创建 trigram GIN 索引失败：${(err as Error).message}`,
      );
    }

    // 迁移：documents.user_id → documents.created_by
    // TypeORM synchronize=true 会自动建 created_by 列，但为兼容已有 user_id 数据需显式 RENAME
    try {
      await this.entityManager.query(
        `ALTER TABLE documents RENAME COLUMN user_id TO created_by;`,
      );
      this.logger.log('已迁移 documents.user_id → created_by');
    } catch (err) {
      // 列已改名或不存在，忽略
    }

    // 迁移：为 categories 表显式 ADD created_by 列
    // synchronize 会自动建，但保险起见也显式 ALTER ADD IF NOT EXISTS
    try {
      await this.entityManager.query(
        `ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by uuid;`,
      );
      this.logger.log('categories.created_by 列已就绪');
    } catch (err) {
      this.logger.error(
        `添加 categories.created_by 列失败：${(err as Error).message}`,
      );
    }

    // 迁移：存量 Document 回填归属字段
    // owner_type/owner_id 默认 personal + created_by；content_source 按格式回填
    try {
      await this.entityManager.query(
        `UPDATE documents SET owner_type = 'personal', owner_id = created_by
         WHERE owner_type IS NULL OR owner_id IS NULL;`,
      );
      await this.entityManager.query(
        `UPDATE documents SET content_source = 'manual'
         WHERE content_source IS NULL AND format IN ('md','txt');`,
      );
      await this.entityManager.query(
        `UPDATE documents SET content_source = 'pandoc'
         WHERE content_source IS NULL AND format IN ('docx','odt');`,
      );
      await this.entityManager.query(
        `UPDATE documents SET content_source = 'pdf_text'
         WHERE content_source IS NULL AND format = 'pdf';`,
      );
      this.logger.log('存量文档归属/正文来源字段已回填');
    } catch (err) {
      this.logger.error(
        `回填文档归属字段失败：${(err as Error).message}`,
      );
    }

    // 迁移：存量文档 content 中的图片链接 /uploads/images/<docId>/<name>
    // → /api/files/<docId>/image/<name>（静态文件已改为鉴权接口）
    try {
      const rewrote = await this.entityManager.query(
        `UPDATE documents
         SET content = regexp_replace(
               content,
               '/uploads/images/([^/]+)/([^/)")\\s]+)',
               '/api/files/\\1/image/\\2', 'g')
         WHERE content LIKE '%/uploads/images/%';`,
      );
      if (rewrote?.rowCount && rewrote.rowCount > 0) {
        this.logger.log(
          `已迁移 ${rewrote.rowCount} 篇文档的图片链接到鉴权接口`,
        );
      }
    } catch (err) {
      this.logger.error(
        `迁移图片链接失败：${(err as Error).message}`,
      );
    }
  }
}

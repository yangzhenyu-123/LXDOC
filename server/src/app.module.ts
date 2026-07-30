import {
  Module,
  OnApplicationBootstrap,
  Logger,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InjectEntityManager, TypeOrmModule } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { databaseConfig } from './config/database.config';
import { HealthModule } from './health/health.module';
import { CategoriesModule } from './categories/categories.module';
import { UploadsModule } from './uploads/uploads.module';
import { DocumentsModule } from './documents/documents.module';
import { SearchModule } from './search/search.module';

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
    // 全文检索模块（依赖 pg_trgm + GIN trgm 索引）
    SearchModule,
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
   * synchronize 已完成建表，此处可安全执行
   * 用 try/catch 包裹，连接失败时不影响服务启动
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
  }
}

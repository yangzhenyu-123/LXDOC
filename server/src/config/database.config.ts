import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * TypeORM 配置工厂
 * 从环境变量读取 PostgreSQL 连接参数：
 *   DB_HOST / DB_PORT / DB_USER / DB_PASS / DB_NAME
 * 开发期开启 synchronize 自动建表，关闭 migrationsRun
 */
export const databaseConfig = (
  configService: ConfigService,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get<string>('DB_HOST', 'localhost'),
  port: configService.get<number>('DB_PORT', 5432),
  username: configService.get<string>('DB_USER', 'lxdoc'),
  password: configService.get<string>('DB_PASS', 'lxdoc'),
  database: configService.get<string>('DB_NAME', 'lxdoc'),
  // 编译产物位于 dist/ 下，按实体文件 glob 匹配
  entities: ['dist/**/*.entity.js'],
  synchronize: true,
  migrationsRun: false,
  logging: false,
});

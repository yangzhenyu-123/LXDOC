/**
 * 集成测试 DB helper
 *
 * 在远程 PG（地址见 server/.env 的 DB_HOST）创建独立测试 schema，实现测试数据隔离：
 * - beforeEach: CREATE SCHEMA test_<ts>_<rand>，TypeORM 在该 schema 建表
 * - afterEach: DROP SCHEMA CASCADE，彻底清理
 *
 * KbChunk 实体 synchronize=false，TypeORM 不建 kb_chunks 表，
 * helper 手动建表 + embedding vector(1024) 列 + HNSW/GIN 索引。
 *
 * 设计权衡（已采纳）：
 * - 不用 Testcontainers：开发机 Docker 18.09 太旧 + 镜像下载慢
 * - 用远程 PG + schema 隔离：启动 < 1s，pgvector/pg_trgm 已就绪
 * - schema 名带时间戳避免并发冲突
 */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// 测试用 entity 类（ts-jest 编译，避免 dist glob 依赖）
import { User } from '../src/users/user.entity';
import { Document } from '../src/documents/document.entity';
import { DocumentVersion } from '../src/documents/document-version.entity';
import { DocumentFavorite } from '../src/documents/document-favorite.entity';
import { DocumentAttachment } from '../src/documents/document-attachment.entity';
import { Category } from '../src/categories/category.entity';
import { Organization } from '../src/organizations/organization.entity';
import { UserOrgRole } from '../src/organizations/user-org-role.entity';
import { AuditLog } from '../src/audit/audit-log.entity';
import { SystemSetting } from '../src/system/system-setting.entity';
import { LlmConfig } from '../src/llm/llm-config.entity';
import { KnowledgeBase } from '../src/knowledge-base/entities/knowledge-base.entity';
import { KbChunk } from '../src/knowledge-base/entities/kb-chunk.entity';
import { MessageFeedback } from '../src/knowledge-base/entities/message-feedback.entity';
import { KbIngestionRequest } from '../src/kb-ingestion/entities/kb-ingestion-request.entity';
import { KbIngestionReview } from '../src/kb-ingestion/entities/kb-ingestion-review.entity';
import { Notification } from '../src/notifications/entities/notification.entity';

/**
 * 从 server/.env 加载环境变量（测试不经过 Nest ConfigModule）
 * 避免在测试代码硬编码 DB 密码等敏感信息
 */
function loadEnvFile(): void {
  const envPath = resolve(__dirname, '..', '.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env 不存在时跳过（依赖环境变量已外部设置）
  }
}
loadEnvFile();

/** 测试用 DB 连接参数（从环境变量，无硬编码） */
const DB_CONFIG = {
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER ?? 'lxdoc',
  password: process.env.DB_PASS ?? '',
  database: process.env.DB_NAME ?? 'lxdoc',
};

/** 所有 entity 类（synchronize 用） */
const ENTITIES = [
  User,
  Document,
  DocumentVersion,
  DocumentFavorite,
  DocumentAttachment,
  Category,
  Organization,
  UserOrgRole,
  AuditLog,
  SystemSetting,
  LlmConfig,
  KnowledgeBase,
  KbChunk,
  MessageFeedback,
  KbIngestionRequest,
  KbIngestionReview,
  Notification,
];

/** 测试 schema 句柄 */
export interface TestDb {
  /** DataSource（已初始化，search_path 已设到 test schema） */
  ds: DataSource;
  /** 测试 schema 名（DROP 用） */
  schema: string;
  /** 清理：DROP SCHEMA + 关闭连接 */
  close: () => Promise<void>;
}

/**
 * 创建测试 DB（独立 schema）
 *
 * 步骤：
 * 1. 生成唯一 schema 名
 * 2. CREATE SCHEMA
 * 3. DataSource 配置 schema 选项（TypeORM 自动 SET search_path）
 * 4. synchronize=true 让 TypeORM 建所有表（KbChunk 除外，synchronize=false）
 * 5. 手动建 kb_chunks 表 + embedding 列 + 索引
 *
 * @returns TestDb 句柄
 */
export async function createTestDb(): Promise<TestDb> {
  const schema = `test_${Date.now()}_${randomUUID().slice(0, 8)}`;

  // 1. 先用裸连接 CREATE SCHEMA + 在 public schema 装扩展（共享）
  //    扩展装在 public（一次），所有 test schema 通过 search_path=test_xxx,public 可见。
  //    不能用 SCHEMA "${schema}" + IF NOT EXISTS：IF NOT EXISTS 会让后续测试 schema 装扩展被跳过。
  const bootstrap = new DataSource({
    type: 'postgres',
    ...DB_CONFIG,
    synchronize: false,
    entities: [],
  });
  await bootstrap.initialize();
  await bootstrap.query(`CREATE SCHEMA "${schema}";`);
  // 扩展装到 public（共享，幂等）：pgcrypto 提供 gen_random_uuid，uuid-ossp 提供 uuid_generate_v4
  // （MessageFeedback 实体用 @PrimaryGeneratedColumn('uuid')，TypeORM 默认调 uuid_generate_v4），
  // pg_trgm 提供 GIN trigram 索引，vector 提供 pgvector 类型
  await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
  await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
  await bootstrap.destroy();

  // 2. 主 DataSource：schema 选项让 TypeORM 建/查表都在该 schema
  //    pg driver 的 extra.options 会在每个连接池连接启动时执行 `-c search_path=xxx`，
  //    确保 raw SQL（entityManager.query）也走 test schema，不污染生产 public
  const ds = new DataSource({
    type: 'postgres',
    ...DB_CONFIG,
    schema,
    entities: ENTITIES,
    synchronize: true,
    logging: false,
    extra: {
      // pg 连接初始化：search_path 优先 test schema（表隔离），public 在后（vector 类型可见）
      // test schema 在前确保 raw SQL 的表名解析优先 test schema，不污染生产 public
      options: `-c search_path=${schema},public`,
    },
    // 禁用外键约束检查，避免 entity 间依赖顺序问题（测试不依赖 FK）
    // migrationsRun: false,
  });
  await ds.initialize();

  // 3. 手动建 kb_chunks 表（KbChunk synchronize=false，TypeORM 不建）
  //    embedding 列 + HNSW/GIN 索引（与生产 AppModule.onApplicationBootstrap 一致）
  await ds.query(`
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kb_id uuid NOT NULL,
      document_id uuid NOT NULL,
      chunk_index int NOT NULL,
      content text NOT NULL,
      parent_chunk_id uuid,
      heading_path text,
      chunk_type text,
      metadata jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now()
    );
  `);
  await ds.query(`ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS embedding vector(1024);`);
  await ds.query(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks (kb_id);`);
  await ds.query(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding_hnsw ON kb_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);`);
  await ds.query(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_content_trgm ON kb_chunks USING GIN (content gin_trgm_ops);`);
  await ds.query(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb_doc ON kb_chunks (kb_id, document_id);`);

  // 入库审核：partial unique index（与生产 AppModule.onApplicationBootstrap 一致）
  await ds.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_ingestion_active
    ON kb_ingestion_requests (kb_id, document_id)
    WHERE status IN ('pending', 'approved');
  `);

  return {
    ds,
    schema,
    close: async () => {
      await ds.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      await ds.destroy();
    },
  };
}

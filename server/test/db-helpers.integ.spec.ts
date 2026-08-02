/**
 * 集成测试基础设施验证
 *
 * 确认：
 * - 能连远程 PG（地址见 server/.env 的 DB_HOST）+ CREATE SCHEMA
 * - TypeORM synchronize 在 test schema 建表
 * - kb_chunks 手动建表 + embedding 列 + 索引成功
 * - raw SQL（entityManager.query）能找到 test schema 的表
 * - DROP SCHEMA CASCADE 清理干净
 */
import { createTestDb, TestDb } from './db-helpers';

describe('集成测试基础设施', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  it('创建测试 schema 并建表', async () => {
    expect(db.schema).toMatch(/^test_\d+_[0-9a-f]+$/);
    // documents 表由 TypeORM synchronize 建在 test schema
    const docs = await db.ds.query(`SELECT to_regclass('documents') AS t;`);
    expect(docs[0].t).toBe('documents');
  });

  it('kb_chunks 表 + embedding 列 + 索引就绪', async () => {
    const chunks = await db.ds.query(`SELECT to_regclass('kb_chunks') AS t;`);
    expect(chunks[0].t).toBe('kb_chunks');
    // embedding 列存在（限定 test schema，避免查到 public 的 kb_chunks）
    const cols = await db.ds.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'kb_chunks' AND column_name = 'embedding'
    `, [db.schema]);
    expect(cols).toHaveLength(1);
    expect(cols[0].data_type).toBe('USER-DEFINED'); // vector 类型
  });

  it('向量写入 + cosine 距离查询', async () => {
    // 插入一个 chunk 带 embedding
    const vec = Array.from({ length: 1024 }, () => 0.1);
    const vecLiteral = `[${vec.join(',')}]`;
    await db.ds.query(
      `INSERT INTO kb_chunks (kb_id, document_id, chunk_index, content, embedding)
       VALUES ($1, $2, 0, $3, $4::vector)`,
      [randomUUID(), randomUUID(), '测试内容', vecLiteral],
    );
    // 查询 cosine 距离
    const rows = await db.ds.query(
      `SELECT id, content, 1 - (embedding <=> $1::vector) AS similarity
       FROM kb_chunks WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector LIMIT 1`,
      [vecLiteral],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('测试内容');
    expect(rows[0].similarity).toBeCloseTo(1.0, 5); // 自己与自己的 cosine 相似度 = 1
  });

  it('trigram similarity 查询', async () => {
    await db.ds.query(
      `INSERT INTO kb_chunks (kb_id, document_id, chunk_index, content)
       VALUES ($1, $2, 0, '企业知识库 RAG 检索测试')`,
      [randomUUID(), randomUUID()],
    );
    const rows = await db.ds.query(
      `SELECT content, similarity(content, $1) AS sim
       FROM kb_chunks WHERE similarity(content, $1) > 0.05
       ORDER BY sim DESC LIMIT 1`,
      ['知识库检索'],
    );
    expect(rows).toHaveLength(1);
    // trigram 相似度应大于 0（有重叠 trigram），不强制 > 0.05 避免边界精度问题
    expect(rows[0].sim).toBeGreaterThan(0);
  });

  it('多个测试 schema 互不干扰（并发安全验证）', async () => {
    // 在当前 schema 插入数据
    await db.ds.query(
      `INSERT INTO kb_chunks (kb_id, document_id, chunk_index, content)
       VALUES ($1, $2, 0, 'schema A 数据')`,
      [randomUUID(), randomUUID()],
    );
    // 当前 schema 应能看到自己的数据
    const rowsA = await db.ds.query(`SELECT content FROM kb_chunks;`);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].content).toBe('schema A 数据');
    // 创建第二个 schema
    const db2 = await createTestDb();
    try {
      // 第二个 schema 应该看不到第一个的数据
      const rowsB = await db2.ds.query(`SELECT content FROM kb_chunks;`);
      expect(rowsB).toHaveLength(0);
    } finally {
      await db2.close();
    }
  });

  it('search_path 隔离到 test schema（不污染生产 public）', async () => {
    // 验证当前连接的 search_path 优先 test schema，public 在后（vector 类型可见）
    const result = await db.ds.query(`SHOW search_path;`);
    const path = result[0].search_path;
    // test schema 必须在 search_path 中
    expect(path).toContain(db.schema);
    // test schema 必须在 public 之前（保证表名解析优先 test schema）
    const testIdx = path.indexOf(db.schema);
    const publicIdx = path.indexOf('public');
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(publicIdx).toBeGreaterThan(testIdx); // public 在 test 之后
  });

  it('close 后 schema 被清理', async () => {
    const schema = db.schema;
    // 测试内手动 close，afterEach 不会再调（db 已设为 closed 状态）
    await db.close();
    db = undefined as any; // 标记已清理，防止 afterEach 重复 close
    // 用新连接验证 schema 已删
    const check = await createTestDb();
    try {
      const result = await check.ds.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [schema],
      );
      expect(result).toHaveLength(0);
    } finally {
      await check.close();
    }
  });
});

// 测试用 helper（避免重复 import randomUUID）
function randomUUID(): string {
  const { randomUUID: r } = require('crypto');
  return r();
}

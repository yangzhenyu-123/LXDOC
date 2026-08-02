/**
 * T5 集成测试：KnowledgeBaseService + RetrievalService
 *
 * 覆盖：
 * - KB CRUD：create / findOne / findAll / update / remove
 * - addDocument：markdown 切分 + embedding + 入库 + 计数
 * - removeDocument：删除 chunks + 计数递减
 * - listDocuments / getStats
 * - retrieve：真 pgvector 向量召回 + 真 trgm 词法召回 + RRF 融合
 *
 * 依赖：
 * - createTestDb（独立 schema + 真 pgvector/pg_trgm）
 * - createMockEmbeddingService（确定性向量 / 自定义向量映射）
 */
import { createTestDb, TestDb } from './db-helpers';
import { createMockEmbeddingService, unitVector, deterministicVector } from './mock-embedding';
import { createMockRerankService } from './mock-rerank';
import { KnowledgeBaseService } from '../src/knowledge-base/knowledge-base.service';
import { RetrievalService } from '../src/knowledge-base/retrieval.service';
import { ChunkingService } from '../src/knowledge-base/chunking.service';
import { KnowledgeBase } from '../src/knowledge-base/entities/knowledge-base.entity';
import { KbChunk } from '../src/knowledge-base/entities/kb-chunk.entity';
import { Document, DocumentFormat, ContentSource } from '../src/documents/document.entity';
import { randomUUID } from 'crypto';

describe('T5 KnowledgeBaseService + RetrievalService 集成测试', () => {
  let db: TestDb;
  let kbService: KnowledgeBaseService;
  let retrievalService: RetrievalService;
  let embeddingService: ReturnType<typeof createMockEmbeddingService>;
  const userId = randomUUID();

  beforeEach(async () => {
    db = await createTestDb();
    embeddingService = createMockEmbeddingService();
    const chunkingService = new ChunkingService();
    kbService = new KnowledgeBaseService(
      db.ds.getRepository(KnowledgeBase),
      db.ds.getRepository(KbChunk),
      db.ds.getRepository(Document),
      chunkingService,
      embeddingService,
      db.ds.manager,
      // LLM 未启用（generateSampleQuestions 测试单独 mock）
      { isReady: () => false } as any,
    );
    retrievalService = new RetrievalService(db.ds.manager, embeddingService, createMockRerankService({ isReady: false }));
  });

  afterEach(async () => {
    await db.close();
  });

  // ========== KB CRUD ==========

  describe('KB CRUD', () => {
    it('create 创建知识库', async () => {
      const kb = await kbService.create({ name: '测试KB', createdBy: userId });
      expect(kb.id).toBeDefined();
      expect(kb.name).toBe('测试KB');
      expect(kb.documentCount).toBe(0);
      expect(kb.chunkCount).toBe(0);
      expect(kb.embeddingModel).toBe('BAAI/bge-m3');
      expect(kb.embeddingDimensions).toBe(1024);
    });

    it('findOne 找不到时抛 NotFoundException', async () => {
      await expect(kbService.findOne(randomUUID())).rejects.toThrow('不存在');
    });

    it('findAll 返回所有 KB（按创建时间降序）', async () => {
      await kbService.create({ name: 'KB1', createdBy: userId });
      await kbService.create({ name: 'KB2', createdBy: userId });
      const all = await kbService.findAll();
      expect(all).toHaveLength(2);
      // 降序：KB2 在前
      expect(all[0].name).toBe('KB2');
    });

    it('update 修改名称和描述', async () => {
      const kb = await kbService.create({ name: '原名', createdBy: userId });
      const updated = await kbService.update(kb.id, { name: '新名', description: '描述' });
      expect(updated.name).toBe('新名');
      expect(updated.description).toBe('描述');
    });

    it('remove 删除 KB 及其所有 chunk', async () => {
      const kb = await kbService.create({ name: '待删', createdBy: userId });
      await kbService.remove(kb.id);
      await expect(kbService.findOne(kb.id)).rejects.toThrow('不存在');
    });
  });

  // ========== addDocument ==========

  describe('addDocument', () => {
    async function createDoc(content: string, title = '测试文档'): Promise<string> {
      const doc = db.ds.getRepository(Document).create({
        id: randomUUID(),
        categoryId: randomUUID(),
        title,
        content,
        format: DocumentFormat.MD,
        createdBy: userId,
        contentSource: ContentSource.MANUAL,
      });
      const saved = await db.ds.getRepository(Document).save(doc);
      return saved.id;
    }

    it('markdown 切分 + embedding + 入库 + 计数', async () => {
      const kb = await kbService.create({ name: 'KB', createdBy: userId });
      const docId = await createDoc('# 标题1\n\n段落A内容\n\n# 标题2\n\n段落B内容');
      const chunkCount = await kbService.addDocument(kb.id, docId);
      expect(chunkCount).toBeGreaterThan(0);

      // 验证 chunk 入库
      const chunks = await db.ds.query(`SELECT * FROM kb_chunks WHERE kb_id = $1`, [kb.id]);
      expect(chunks.length).toBe(chunkCount);
      // 验证 embedding 写入
      const embedded = await db.ds.query(`SELECT COUNT(*) AS cnt FROM kb_chunks WHERE kb_id = $1 AND embedding IS NOT NULL`, [kb.id]);
      expect(Number(embedded[0].cnt)).toBe(chunkCount);

      // 验证 KB 计数（注：documentCount bug 在 T7 修复，此处只验证 chunkCount）
      const kbAfter = await kbService.findOne(kb.id);
      expect(kbAfter.chunkCount).toBe(chunkCount);
    });

    it('切分保留 heading_path', async () => {
      const kb = await kbService.create({ name: 'KB', createdBy: userId });
      const docId = await createDoc('# 安装指南\n\n## 环境要求\n\n需要 Node.js 18+');
      await kbService.addDocument(kb.id, docId);
      const chunks = await db.ds.query(`SELECT heading_path FROM kb_chunks WHERE kb_id = $1`, [kb.id]);
      // 至少有一个 chunk 带 heading_path
      const hasHeading = chunks.some((c: any) => c.heading_path && c.heading_path.length > 0);
      expect(hasHeading).toBe(true);
    });

    it('文档无正文抛 BadRequestException', async () => {
      const kb = await kbService.create({ name: 'KB', createdBy: userId });
      const doc = db.ds.getRepository(Document).create({
        id: randomUUID(),
        categoryId: randomUUID(),
        title: '空文档',
        content: '   ',
        format: DocumentFormat.DOC,
        createdBy: userId,
      });
      await db.ds.getRepository(Document).save(doc);
      await expect(kbService.addDocument(kb.id, doc.id)).rejects.toThrow('无可解析正文');
    });

    it('文档不存在抛 NotFoundException', async () => {
      const kb = await kbService.create({ name: 'KB', createdBy: userId });
      await expect(kbService.addDocument(kb.id, randomUUID())).rejects.toThrow('不存在');
    });

    it('重复 addDocument 同一文档：先删旧 chunk 再写入', async () => {
      const kb = await kbService.create({ name: 'KB', createdBy: userId });
      const docId = await createDoc('# 标题\n\n内容A');
      const count1 = await kbService.addDocument(kb.id, docId);
      // 重新加入（模拟重新切分）
      const count2 = await kbService.addDocument(kb.id, docId);
      expect(count2).toBe(count1); // 同样内容切分数相同
      // chunk 数不应翻倍（旧 chunk 已删）
      const chunks = await db.ds.query(`SELECT COUNT(*) AS cnt FROM kb_chunks WHERE kb_id = $1 AND document_id = $2`, [kb.id, docId]);
      expect(Number(chunks[0].cnt)).toBe(count2);
    });

    /**
     * T7 TDD：KB 计数器 bug 暴露测试
     *
     * bug 现象（P2 遗留）：documentCount=4 实际 1 个文档
     * 根源（addDocument line 157-165）：
     *   - documentCount 每次 addDocument 都 increment +1，即使文档已存在（先 delete 旧 chunk 再加，实际文档数没变）
     *   - chunkCount 每次 update 覆盖为本次 saved.length，而非累加（多文档场景只记最后文档的 chunk 数）
     *
     * 期望行为：
     *   - 重复加入同一文档：documentCount 不变（替换不增加）
     *   - 加入不同文档：documentCount 递增，chunkCount 累加
     */
    it('T7 计数器：重复加入同一文档 documentCount 不应递增', async () => {
      const kb = await kbService.create({ name: 'KB', createdBy: userId });
      const docId = await createDoc('# 标题\n\n内容A');

      await kbService.addDocument(kb.id, docId);
      const kbAfter1 = await kbService.findOne(kb.id);
      expect(kbAfter1.documentCount).toBe(1); // 加入 1 次 = 1

      await kbService.addDocument(kb.id, docId); // 重复加入同一文档
      const kbAfter2 = await kbService.findOne(kb.id);
      // bug：documentCount 变成 2（应为 1，文档没增加）
      expect(kbAfter2.documentCount).toBe(1); // 期望：仍是 1
    });

    it('T7 计数器：加入不同文档 chunkCount 应累加', async () => {
      const kb = await kbService.create({ name: 'KB', createdBy: userId });
      const doc1 = await createDoc('# 标题1\n\n内容A', '文档1');
      const doc2 = await createDoc('# 标题2\n\n内容B', '文档2');

      const count1 = await kbService.addDocument(kb.id, doc1);
      const kbAfter1 = await kbService.findOne(kb.id);
      expect(kbAfter1.chunkCount).toBe(count1);

      const count2 = await kbService.addDocument(kb.id, doc2);
      const kbAfter2 = await kbService.findOne(kb.id);
      // bug：chunkCount 被覆盖为 count2（应为 count1 + count2）
      expect(kbAfter2.chunkCount).toBe(count1 + count2); // 期望：累加
      expect(kbAfter2.documentCount).toBe(2);
    });
  });

  // ========== removeDocument ==========

  describe('removeDocument', () => {
    it('删除文档的所有 chunk + 计数递减', async () => {
      const kb = await kbService.create({ name: 'KB', createdBy: userId });
      const doc = db.ds.getRepository(Document).create({
        id: randomUUID(), categoryId: randomUUID(), title: 'T',
        content: '# A\n\n内容A', format: DocumentFormat.MD, createdBy: userId,
      });
      await db.ds.getRepository(Document).save(doc);
      const chunkCount = await kbService.addDocument(kb.id, doc.id);
      expect(chunkCount).toBeGreaterThan(0);

      await kbService.removeDocument(kb.id, doc.id);
      const remaining = await db.ds.query(`SELECT COUNT(*) AS cnt FROM kb_chunks WHERE kb_id = $1 AND document_id = $2`, [kb.id, doc.id]);
      expect(Number(remaining[0].cnt)).toBe(0);
    });
  });

  // ========== listDocuments / getStats ==========

  describe('listDocuments / getStats', () => {
    it('listDocuments 返回 KB 内文档 + chunk 数', async () => {
      const kb = await kbService.create({ name: 'KB', createdBy: userId });
      const doc = db.ds.getRepository(Document).create({
        id: randomUUID(), categoryId: randomUUID(), title: '文档X',
        content: '# A\n\n内容A', format: DocumentFormat.MD, createdBy: userId,
      });
      await db.ds.getRepository(Document).save(doc);
      await kbService.addDocument(kb.id, doc.id);

      const list = await kbService.listDocuments(kb.id);
      expect(list).toHaveLength(1);
      expect(list[0].documentId).toBe(doc.id);
      expect(list[0].title).toBe('文档X');
      expect(list[0].chunkCount).toBeGreaterThan(0);
    });

    it('getStats 返回 KB 统计', async () => {
      const kb = await kbService.create({ name: 'KB', createdBy: userId });
      const doc = db.ds.getRepository(Document).create({
        id: randomUUID(), categoryId: randomUUID(), title: 'T',
        content: '# A\n\n内容A', format: DocumentFormat.MD, createdBy: userId,
      });
      await db.ds.getRepository(Document).save(doc);
      const chunkCount = await kbService.addDocument(kb.id, doc.id);

      const stats = await kbService.getStats(kb.id);
      expect(stats.chunkCount).toBe(chunkCount);
      expect(stats.embeddedCount).toBe(chunkCount);
    });
  });

  // ========== retrieve（真 pgvector + 真 trgm） ==========

  describe('retrieve', () => {
    /**
     * 直接用 raw SQL 插入带特定 embedding 的 chunk，绕过 mock embedding
     * 用于精确控制向量召回的相似度
     */
    async function insertChunk(opts: {
      kbId: string;
      documentId: string;
      content: string;
      vector: number[];
      headingPath?: string;
    }): Promise<void> {
      const vecLiteral = `[${opts.vector.join(',')}]`;
      await db.ds.query(
        `INSERT INTO kb_chunks (id, kb_id, document_id, chunk_index, content, heading_path, chunk_type, metadata, embedding)
         VALUES ($1, $2, $3, 0, $4, $5, 'text', '{}', $6::vector)`,
        [randomUUID(), opts.kbId, opts.documentId, opts.content, opts.headingPath ?? null, vecLiteral],
      );
    }

    it('向量召回：query 向量与 chunk A 最相似 → A 排第一', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      // chunk A 向量 = e1，chunk B 向量 = e2（正交，cosine 相似度 = 0）
      await insertChunk({ kbId, documentId: docId, content: '内容A', vector: unitVector(0) });
      await insertChunk({ kbId, documentId: docId, content: '内容B', vector: unitVector(1) });

      // mock query embedding 返回 e1（与 A 相似）
      embeddingService = createMockEmbeddingService({
        vectorMap: new Map([['查询', unitVector(0)]]),
      });
      retrievalService = new RetrievalService(db.ds.manager, embeddingService, createMockRerankService({ isReady: false }));

      const results = await retrievalService.retrieve(kbId, '查询', { vectorTopK: 5, trgmTopK: 5, finalTopK: 5 });
      expect(results.length).toBeGreaterThan(0);
      // A 应排前（向量相似度高）
      const topContent = results[0].content;
      expect(topContent).toBe('内容A');
    });

    it('词法召回：trigram similarity 命中相似文本', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      // 文本高度相似（trigram 重叠多）
      await insertChunk({ kbId, documentId: docId, content: '企业知识库架构设计文档', vector: unitVector(0) });
      await insertChunk({ kbId, documentId: docId, content: '完全不同的XYZ内容123', vector: unitVector(1) });

      // embedding 未就绪 → 仅走词法召回
      embeddingService = createMockEmbeddingService({ isReady: false });
      retrievalService = new RetrievalService(db.ds.manager, embeddingService, createMockRerankService({ isReady: false }));

      const results = await retrievalService.retrieve(kbId, '知识库架构', { trgmTopK: 5, finalTopK: 5 });
      // 第一个 chunk 文本相似度高，应被召回
      expect(results.some((r) => r.content.includes('知识库架构'))).toBe(true);
    });

    it('RRF 融合：both 命中（向量+词法都命中同一 chunk）分数最高', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      // chunk X：向量与 query 相近 + 文本与 query 相似 → both 命中
      await insertChunk({ kbId, documentId: docId, content: 'RAG 检索增强生成架构', vector: unitVector(0) });
      // chunk Y：仅向量相近，文本不相似 → vector 命中
      await insertChunk({ kbId, documentId: docId, content: 'XYZ完全不相关', vector: unitVector(0) });
      // chunk Z：仅文本相似，向量远 → trgm 命中
      await insertChunk({ kbId, documentId: docId, content: 'RAG 检索增强方法', vector: unitVector(2) });

      embeddingService = createMockEmbeddingService({
        vectorMap: new Map([['RAG 检索', unitVector(0)]]),
      });
      retrievalService = new RetrievalService(db.ds.manager, embeddingService, createMockRerankService({ isReady: false }));

      const results = await retrievalService.retrieve(kbId, 'RAG 检索', { vectorTopK: 10, trgmTopK: 10, finalTopK: 10 });
      // X 应排前（both 命中，分数最高）
      const top = results[0];
      expect(top.content).toContain('RAG 检索增强生成架构');
      // 验证 hitBy 标记
      const xResult = results.find((r) => r.content.includes('检索增强生成架构'));
      expect(xResult?.hitBy).toBe('both');
    });

    it('embedding 未就绪时仅走词法召回（降级）', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      await insertChunk({ kbId, documentId: docId, content: '降级测试内容文本', vector: unitVector(0) });

      embeddingService = createMockEmbeddingService({ isReady: false });
      retrievalService = new RetrievalService(db.ds.manager, embeddingService, createMockRerankService({ isReady: false }));

      const results = await retrievalService.retrieve(kbId, '降级测试', { trgmTopK: 5, finalTopK: 5 });
      expect(results.length).toBeGreaterThan(0);
      // 仅 trgm 命中
      expect(results.every((r) => r.hitBy === 'trgm')).toBe(true);
    });

    it('空 query 返回空数组', async () => {
      const kbId = randomUUID();
      const results = await retrievalService.retrieve(kbId, '   ');
      expect(results).toEqual([]);
    });

    it('F5 documentIds 过滤：只检索选中文档的 chunk', async () => {
      const kbId = randomUUID();
      const docA = randomUUID();
      const docB = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      // docA chunk 内容含"目标词"
      await insertChunk({ kbId, documentId: docA, content: '目标词 内容A', vector: unitVector(0) });
      // docB chunk 内容也含"目标词"
      await insertChunk({ kbId, documentId: docB, content: '目标词 内容B', vector: unitVector(0) });

      // mock query embedding 与两者都相似
      embeddingService = createMockEmbeddingService({
        vectorMap: new Map([['目标词', unitVector(0)]]),
      });
      retrievalService = new RetrievalService(db.ds.manager, embeddingService, createMockRerankService({ isReady: false }));

      // 不限文档 → 两条都返回
      const all = await retrievalService.retrieve(kbId, '目标词', {
        vectorTopK: 10, trgmTopK: 10, finalTopK: 10,
      });
      expect(all.length).toBe(2);

      // 只选 docA → 只返回 docA 的 chunk
      const filtered = await retrievalService.retrieve(kbId, '目标词', {
        vectorTopK: 10, trgmTopK: 10, finalTopK: 10,
        documentIds: [docA],
      });
      expect(filtered.length).toBe(1);
      expect(filtered[0].documentId).toBe(docA);
      expect(filtered[0].content).toContain('内容A');
    });
  });

  // ========== F3 引用预览：getChunk ==========

  describe('F3 getChunk（引用预览）', () => {
    it('正常返回 chunk 完整内容', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      const chunkId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      await db.ds.query(
        `INSERT INTO kb_chunks (id, kb_id, document_id, chunk_index, content, heading_path, chunk_type, metadata)
         VALUES ($1, $2, $3, 2, 'chunk 全文内容', '章节>子节', 'text', '{}')`,
        [chunkId, kbId, docId],
      );

      const chunk = await kbService.getChunk(kbId, chunkId);
      expect(chunk.id).toBe(chunkId);
      expect(chunk.documentId).toBe(docId);
      expect(chunk.chunkIndex).toBe(2);
      expect(chunk.content).toBe('chunk 全文内容');
      expect(chunk.headingPath).toBe('章节>子节');
      expect(chunk.parentChunkId).toBeNull();
    });

    it('chunk 不属于指定 KB 时抛 NotFoundException（防越权）', async () => {
      const kbId1 = randomUUID();
      const kbId2 = randomUUID();
      const docId = randomUUID();
      const chunkId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB1', $2)`, [kbId1, userId]);
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB2', $2)`, [kbId2, userId]);
      // chunk 属于 kbId1
      await db.ds.query(
        `INSERT INTO kb_chunks (id, kb_id, document_id, chunk_index, content, chunk_type, metadata)
         VALUES ($1, $2, $3, 0, '内容', 'text', '{}')`,
        [chunkId, kbId1, docId],
      );

      // 用 kbId2 查 → 不应找到
      await expect(kbService.getChunk(kbId2, chunkId)).rejects.toThrow(/不属于知识库/);
    });

    it('KB 不存在时抛 NotFoundException', async () => {
      const fakeKbId = randomUUID();
      const fakeChunkId = randomUUID();
      await expect(kbService.getChunk(fakeKbId, fakeChunkId)).rejects.toThrow(/不存在/);
    });
  });

  // ========== R1 Rerank ==========

  describe('R1 Rerank 二次排序', () => {
    async function insertChunk(opts: {
      kbId: string;
      documentId: string;
      content: string;
      vector: number[];
      headingPath?: string;
    }): Promise<void> {
      const vecLiteral = `[${opts.vector.join(',')}]`;
      await db.ds.query(
        `INSERT INTO kb_chunks (id, kb_id, document_id, chunk_index, content, heading_path, chunk_type, metadata, embedding)
         VALUES ($1, $2, $3, 0, $4, $5, 'text', '{}', $6::vector)`,
        [randomUUID(), opts.kbId, opts.documentId, opts.content, opts.headingPath ?? null, vecLiteral],
      );
    }

    it('rerank 启用：按 rerank score 重排（RRF 排第 2 的 chunk 被 rerank 提到第 1）', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      // 两个 chunk：A 内容与 query 向量近（RRF rank 1），B 内容与 query 词法近（RRF rank 2）
      await insertChunk({ kbId, documentId: docId, content: '向量召回优先的内容', vector: unitVector(0) });
      await insertChunk({ kbId, documentId: docId, content: '词法召回优先的内容', vector: unitVector(2) });

      // query embedding 与 A 近（向量召回 A 排前），但 rerank 让 B 排前
      embeddingService = createMockEmbeddingService({
        vectorMap: new Map([['查询', unitVector(0)]]),
      });
      // rerank score: B(index 1)=0.9, A(index 0)=0.3 → B 排前
      const rerankService = createMockRerankService({ isReady: true, scores: [0.3, 0.9] });
      retrievalService = new RetrievalService(db.ds.manager, embeddingService, rerankService);

      const results = await retrievalService.retrieve(kbId, '查询', {
        vectorTopK: 10, trgmTopK: 10, finalTopK: 5, rerank: true,
      });
      expect(results.length).toBe(2);
      // rerank 后 B（词法召回优先）应排第 1
      expect(results[0].content).toContain('词法召回优先');
      expect(results[0].score).toBeCloseTo(0.9, 5);
      expect(results[1].content).toContain('向量召回优先');
    });

    it('rerank 未就绪时自动降级为仅 RRF（不报错）', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      await insertChunk({ kbId, documentId: docId, content: '内容A', vector: unitVector(0) });

      embeddingService = createMockEmbeddingService({
        vectorMap: new Map([['查询', unitVector(0)]]),
      });
      // rerank 未就绪
      const rerankService = createMockRerankService({ isReady: false });
      retrievalService = new RetrievalService(db.ds.manager, embeddingService, rerankService);

      const results = await retrievalService.retrieve(kbId, '查询', {
        vectorTopK: 10, trgmTopK: 10, finalTopK: 5, rerank: true,
      });
      // 正常返回，score 是 RRF 分数
      expect(results.length).toBe(1);
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].score).toBeLessThan(1); // RRF 分数远小于 1
    });

    it('rerank 报错时降级为仅 RRF（不阻塞检索）', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      await insertChunk({ kbId, documentId: docId, content: '内容A', vector: unitVector(0) });

      embeddingService = createMockEmbeddingService({
        vectorMap: new Map([['查询', unitVector(0)]]),
      });
      // rerank 就绪但 rerank 方法抛错
      const rerankService = createMockRerankService({ isReady: true });
      (rerankService as any).rerank = jest.fn().mockRejectedValue(new Error('TEI 500'));
      retrievalService = new RetrievalService(db.ds.manager, embeddingService, rerankService);

      const results = await retrievalService.retrieve(kbId, '查询', {
        vectorTopK: 10, trgmTopK: 10, finalTopK: 5, rerank: true,
      });
      expect(results.length).toBe(1);
      // 降级为 RRF 分数
      expect(results[0].score).toBeLessThan(1);
    });

    it('rerankCandidateK 限制送 rerank 的候选数', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      // 插 5 个 chunk
      for (let i = 0; i < 5; i++) {
        await insertChunk({ kbId, documentId: docId, content: `内容${i}`, vector: unitVector(i % 10) });
      }

      embeddingService = createMockEmbeddingService({
        vectorMap: new Map([['查询', unitVector(0)]]),
      });
      const rerankService = createMockRerankService({ isReady: true });
      const rerankSpy = jest.spyOn(rerankService, 'rerank');
      retrievalService = new RetrievalService(db.ds.manager, embeddingService, rerankService);

      // finalTopK=2, rerankCandidateK=3 → 送 rerank 的候选 = max(3, 2) = 3
      await retrievalService.retrieve(kbId, '查询', {
        vectorTopK: 10, trgmTopK: 10, finalTopK: 2, rerank: true, rerankCandidateK: 3,
      });
      expect(rerankSpy).toHaveBeenCalledTimes(1);
      const texts = rerankSpy.mock.calls[0][1];
      expect(texts.length).toBe(3);
    });
  });

  // ========== R4 示例问题生成 ==========

  describe('R4 generateSampleQuestions', () => {
    it('LLM 未启用时抛 BadRequestException', async () => {
      const kbId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      // kbService 默认 llmService 未启用
      await expect(kbService.generateSampleQuestions(kbId)).rejects.toThrow(/AI 服务未启用/);
    });

    it('知识库无文档时抛 BadRequestException', async () => {
      const kbId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      // 重建 kbService，mock llmService 就绪
      const mockLlm = {
        isReady: () => true,
        chat: jest.fn(),
      };
      const newKbService = new KnowledgeBaseService(
        db.ds.getRepository(KnowledgeBase),
        db.ds.getRepository(KbChunk),
        db.ds.getRepository(Document),
        new ChunkingService(),
        embeddingService,
        db.ds.manager,
        mockLlm as any,
      );
      await expect(newKbService.generateSampleQuestions(kbId)).rejects.toThrow(/无文档/);
    });

    it('正常生成示例问题并存到 kb.sample_questions', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      // 插一个 chunk（让 listDocuments 返回非空）
      await db.ds.query(
        `INSERT INTO kb_chunks (id, kb_id, document_id, chunk_index, content, chunk_type, metadata)
         VALUES ($1, $2, $3, 0, '内容', 'text', '{}')`,
        [randomUUID(), kbId, docId],
      );
      // 插对应的 document（用 Repository.create 避免漏必填字段）
      const doc = db.ds.getRepository(Document).create({
        id: docId,
        categoryId: randomUUID(),
        title: 'RAG 架构文档',
        content: '# 内容',
        format: 'md' as any,
        createdBy: userId,
        contentSource: 'manual' as any,
      });
      await db.ds.getRepository(Document).save(doc);

      // mock LLM 返回示例问题
      const mockLlm = {
        isReady: () => true,
        chat: jest.fn().mockResolvedValue({
          content: '什么是 RAG 架构？\n如何配置检索？\nbge-m3 的维度是多少？',
          model: 'mock',
        }),
      };
      const newKbService = new KnowledgeBaseService(
        db.ds.getRepository(KnowledgeBase),
        db.ds.getRepository(KbChunk),
        db.ds.getRepository(Document),
        new ChunkingService(),
        embeddingService,
        db.ds.manager,
        mockLlm as any,
      );

      const questions = await newKbService.generateSampleQuestions(kbId);
      expect(questions.length).toBe(3);
      expect(questions[0]).toContain('RAG');
      // 验证存到 KB
      const kb = await newKbService.findOne(kbId);
      expect(kb.sampleQuestions).toEqual(questions);
      // 验证 LLM 调用参数
      expect(mockLlm.chat).toHaveBeenCalledTimes(1);
      const callArgs = mockLlm.chat.mock.calls[0];
      expect(callArgs[0][0].role).toBe('user');
      expect(callArgs[0][0].content).toContain('RAG 架构文档');
      expect(callArgs[0][0].content).toContain('生成 6 个');
    });

    it('LLM 返回带编号的问题时自动去编号', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      await db.ds.query(
        `INSERT INTO kb_chunks (id, kb_id, document_id, chunk_index, content, chunk_type, metadata)
         VALUES ($1, $2, $3, 0, '内容', 'text', '{}')`,
        [randomUUID(), kbId, docId],
      );
      const doc = db.ds.getRepository(Document).create({
        id: docId,
        categoryId: randomUUID(),
        title: '文档',
        content: '# 内容',
        format: 'md' as any,
        createdBy: userId,
        contentSource: 'manual' as any,
      });
      await db.ds.getRepository(Document).save(doc);

      const mockLlm = {
        isReady: () => true,
        chat: jest.fn().mockResolvedValue({
          content: '1. 问题一\n2. 问题二\n3、问题三\n4) 问题四',
          model: 'mock',
        }),
      };
      const newKbService = new KnowledgeBaseService(
        db.ds.getRepository(KnowledgeBase),
        db.ds.getRepository(KbChunk),
        db.ds.getRepository(Document),
        new ChunkingService(),
        embeddingService,
        db.ds.manager,
        mockLlm as any,
      );

      const questions = await newKbService.generateSampleQuestions(kbId, 4);
      expect(questions).toEqual(['问题一', '问题二', '问题三', '问题四']);
    });

    it('LLM 返回空内容时抛 BadRequestException', async () => {
      const kbId = randomUUID();
      const docId = randomUUID();
      await db.ds.query(`INSERT INTO kb_knowledge_bases (id, name, created_by) VALUES ($1, 'KB', $2)`, [kbId, userId]);
      await db.ds.query(
        `INSERT INTO kb_chunks (id, kb_id, document_id, chunk_index, content, chunk_type, metadata)
         VALUES ($1, $2, $3, 0, '内容', 'text', '{}')`,
        [randomUUID(), kbId, docId],
      );
      const doc = db.ds.getRepository(Document).create({
        id: docId,
        categoryId: randomUUID(),
        title: '文档',
        content: '# 内容',
        format: 'md' as any,
        createdBy: userId,
        contentSource: 'manual' as any,
      });
      await db.ds.getRepository(Document).save(doc);

      const mockLlm = {
        isReady: () => true,
        chat: jest.fn().mockResolvedValue({ content: '', model: 'mock' }),
      };
      const newKbService = new KnowledgeBaseService(
        db.ds.getRepository(KnowledgeBase),
        db.ds.getRepository(KbChunk),
        db.ds.getRepository(Document),
        new ChunkingService(),
        embeddingService,
        db.ds.manager,
        mockLlm as any,
      );

      await expect(newKbService.generateSampleQuestions(kbId)).rejects.toThrow(/生成示例问题失败/);
    });
  });
});

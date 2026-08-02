import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { KnowledgeBase } from './entities/knowledge-base.entity';
import { KbChunk, ChunkType } from './entities/kb-chunk.entity';
import { Document } from '../documents/document.entity';
import { ChunkingService, ChunkResult, ChunkStrategy } from './chunking.service';
import { EmbeddingService } from './embedding.service';
import { LlmService } from '../llm/llm.service';
import { OptionalLlm } from '../llm/optional-llm.decorator';

/**
 * 知识库管理服务
 *
 * 职责：
 * 1. 知识库 CRUD
 * 2. 文档加入/移出知识库（触发 chunking + embedding + 入库）
 * 3. 知识库统计（文档数 / chunk 数）
 *
 * 向量列（embedding vector(1024)）由 raw SQL 读写，TypeORM 不直接映射。
 */
@Injectable()
export class KnowledgeBaseService {
  private readonly logger = new Logger(KnowledgeBaseService.name);
  /**
   * 进程内锁：防止同一 (kbId, documentId) 并发 addDocument 导致 chunk 翻倍（H5 修复）
   * key = `${kbId}:${documentId}`，value = 正在执行的 Promise
   */
  private readonly addDocLocks = new Map<string, Promise<unknown>>();

  constructor(
    @InjectRepository(KnowledgeBase)
    private readonly kbRepo: Repository<KnowledgeBase>,
    @InjectRepository(KbChunk)
    private readonly chunkRepo: Repository<KbChunk>,
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    private readonly chunkingService: ChunkingService,
    private readonly embeddingService: EmbeddingService,
    private readonly entityManager: EntityManager,
    @OptionalLlm() private readonly llmService?: LlmService,
  ) {}

  // ========== 知识库 CRUD ==========

  async create(input: {
    name: string;
    description?: string;
    categoryId?: string;
    chunkStrategy?: Partial<ChunkStrategy>;
    requireReview?: boolean;
    createdBy: string;
  }): Promise<KnowledgeBase> {
    const kb = this.kbRepo.create({
      name: input.name,
      description: input.description ?? null,
      categoryId: input.categoryId ?? null,
      chunkStrategy: input.chunkStrategy ?? {},
      requireReview: input.requireReview ?? false,
      createdBy: input.createdBy,
      documentCount: 0,
      chunkCount: 0,
    });
    const saved = await this.kbRepo.save(kb);
    this.logger.log(`创建知识库 ${saved.id} (${saved.name})`);
    return saved;
  }

  async findAll(): Promise<KnowledgeBase[]> {
    return this.kbRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<KnowledgeBase> {
    const kb = await this.kbRepo.findOne({ where: { id } });
    if (!kb) throw new NotFoundException(`知识库 ${id} 不存在`);
    return kb;
  }

  async update(id: string, input: Partial<Pick<KnowledgeBase, 'name' | 'description' | 'categoryId' | 'chunkStrategy' | 'retrievalConfig' | 'requireReview'>>): Promise<KnowledgeBase> {
    const kb = await this.findOne(id);
    Object.assign(kb, input);
    const saved = await this.kbRepo.save(kb);
    this.logger.log(`更新知识库 ${id}`);
    return saved;
  }

  async remove(id: string): Promise<void> {
    const kb = await this.findOne(id);
    // 级联删除所有 chunk
    await this.chunkRepo.delete({ kbId: id });
    await this.kbRepo.remove(kb);
    this.logger.log(`删除知识库 ${id}（含其全部 chunk）`);
  }

  // ========== 文档加入 / 移出知识库 ==========

  /**
   * 将文档加入知识库
   * 触发：解析文档 content → chunking → embedding → 入库 kb_chunks
   *
   * 计数器逻辑（T7 修复）：
   * - documentCount：文档首次加入 +1，重复加入（已存在旧 chunk）不递增（替换语义）
   * - chunkCount：累加差值（新 chunk 数 - 旧 chunk 数），支持重新切分时增减
   *
   * @returns 生成的 chunk 数量
   */
  async addDocument(kbId: string, documentId: string): Promise<number> {
    // H5 修复：进程内锁防止同一 (kbId, documentId) 并发导致 chunk 翻倍
    const lockKey = `${kbId}:${documentId}`;
    const prev = this.addDocLocks.get(lockKey);
    const current = (async () => {
      try {
        // 串行化同一 (kbId, documentId)：等待前一个任务完成（忽略其异常）
        if (prev) await prev.catch(() => undefined);
        return await this.addDocumentInternal(kbId, documentId);
      } finally {
        // PR review #1 修复：任务完成后清理锁 Map，避免长期运行内存泄漏
        // 仅当 map 中仍注册的是当前 Promise 时才删除，防止后到的并发请求注册的新锁被误删
        if (this.addDocLocks.get(lockKey) === current) {
          this.addDocLocks.delete(lockKey);
        }
      }
    })();
    this.addDocLocks.set(lockKey, current);
    return current;
  }

  private async addDocumentInternal(kbId: string, documentId: string): Promise<number> {
    const kb = await this.findOne(kbId);
    const doc = await this.docRepo.findOne({ where: { id: documentId } });
    if (!doc) throw new NotFoundException(`文档 ${documentId} 不存在`);

    // 文档正文为空（仅预览型格式如 doc/xls），无法加入
    if (!doc.content || !doc.content.trim()) {
      throw new BadRequestException(
        `文档 ${doc.title} 无可解析正文（format=${doc.format}），无法加入知识库`,
      );
    }

    // 1. chunking（在事务外执行，避免长事务占用连接）
    const strategy = kb.chunkStrategy as Partial<ChunkStrategy> | undefined;
    const chunkResults = this.chunkingService.chunk(doc.content, strategy);
    if (chunkResults.length === 0) {
      throw new BadRequestException(`文档 ${doc.title} 切分后无有效 chunk`);
    }

    // 2. embedding 批量生成（在事务外执行）
    const texts = chunkResults.map((c) => c.content);
    const vectors = await this.embeddingService.embedBatch(texts);
    const successCount = vectors.filter(Boolean).length;
    const failedCount = chunkResults.length - successCount;

    // S6 修复：embedding 全部失败时抛错，避免静默入库无效 chunk
    if (successCount === 0) {
      throw new BadRequestException(
        `文档 ${doc.title} embedding 全部失败（共 ${chunkResults.length} 条），请检查 embedding 服务配置`,
      );
    }
    if (failedCount > 0) {
      this.logger.warn(
        `文档 ${doc.title} embedding 部分失败：${failedCount}/${chunkResults.length}，失败 chunk 向量为空（仅词法召回可见）`,
      );
    } else {
      this.logger.log(
        `文档 ${doc.title} embedding：${successCount}/${chunkResults.length} 成功`,
      );
    }

    // 3. 入库（S3 修复：chunk 删除+插入+计数器全部在事务内，失败回滚不丢旧数据）
    await this.entityManager.transaction(async (manager) => {
      // PR review #2 修复：悲观锁 KnowledgeBase 父行，序列化同 kb 的所有 chunk 写操作。
      // 选 KB 行而非 chunk 行的原因：chunk 行在首次加入（oldChunkCount=0）时不存在，
      // FOR UPDATE 锁不到任何行，无法防两个并发"首次加入"都看到 0 并都插入；
      // KB 行必然存在（findOne 已校验），锁它可正确协调单实例外的并发（多实例部署）。
      // 单实例下进程内锁已序列化同一 (kbId, documentId)，此处 DB 锁为多实例兜底。
      await manager
        .getRepository(KnowledgeBase)
        .createQueryBuilder('kb')
        .setLock('pessimistic_write')
        .where('kb.id = :kbId', { kbId })
        .getOne();

      // 事务内查旧 chunk 数（KB 行锁已序列化并发，此处 count 无需再加锁）
      const oldChunkCount = await manager
        .getRepository(KbChunk)
        .count({ where: { kbId, documentId } });
      const isExistingDoc = oldChunkCount > 0;

      // 删除旧 chunk（移入事务，失败则回滚，旧数据不丢）
      if (isExistingDoc) {
        await manager.getRepository(KbChunk).delete({ kbId, documentId });
      }

      // 插入新 chunk
      const chunks: KbChunk[] = chunkResults.map((c, i) => ({
        id: randomUUID(),
        kbId,
        documentId,
        chunkIndex: i,
        content: c.content,
        parentChunkId: null,
        headingPath: c.headingPath,
        chunkType: c.chunkType,
        metadata: c.metadata,
        createdAt: new Date(),
      }));
      const saved = await manager.getRepository(KbChunk).save(chunks);

      // 逐条回填 embedding（vector 列用 raw SQL）
      for (let i = 0; i < saved.length; i++) {
        const vec = vectors[i];
        if (!vec || vec.length === 0) continue;
        const vecLiteral = `[${vec.join(',')}]`;
        await manager.query(
          `UPDATE kb_chunks SET embedding = $1::vector WHERE id = $2`,
          [vecLiteral, saved[i].id],
        );
      }

      // 更新 KB 计数
      if (!isExistingDoc) {
        await manager.getRepository(KnowledgeBase).increment(
          { id: kbId },
          'documentCount',
          1,
        );
      }
      const chunkDelta = saved.length - oldChunkCount;
      if (chunkDelta !== 0) {
        await manager.getRepository(KnowledgeBase).increment(
          { id: kbId },
          'chunkCount',
          chunkDelta,
        );
      }
    });

    this.logger.log(`文档 ${doc.title} 加入知识库 ${kb.name}，生成 ${chunkResults.length} chunk`);
    return chunkResults.length;
  }

  /**
   * 从知识库移除文档（删除其所有 chunk）
   * H4 修复：删除+计数器递减在同一事务内，保证原子性
   * PR review #2：悲观锁 KB 父行，与 addDocument 协调，防多实例下交错导致计数器错乱
   */
  async removeDocument(kbId: string, documentId: string): Promise<void> {
    await this.entityManager.transaction(async (manager) => {
      // 悲观锁 KB 行，与 addDocument 共用同一锁顺序，协调跨方法并发
      await manager
        .getRepository(KnowledgeBase)
        .createQueryBuilder('kb')
        .setLock('pessimistic_write')
        .where('kb.id = :kbId', { kbId })
        .getOne();

      const result = await manager
        .getRepository(KbChunk)
        .delete({ kbId, documentId });
      if (result.affected && result.affected > 0) {
        await manager
          .getRepository(KnowledgeBase)
          .decrement({ id: kbId }, 'documentCount', 1);
        await manager
          .getRepository(KnowledgeBase)
          .decrement({ id: kbId }, 'chunkCount', result.affected);
        this.logger.log(
          `文档 ${documentId} 从知识库 ${kbId} 移除（${result.affected} chunk）`,
        );
      }
    });
  }

  /**
   * 列出知识库中的文档
   */
  async listDocuments(kbId: string): Promise<{ documentId: string; title: string; format: string; chunkCount: number }[]> {
    await this.findOne(kbId);
    // 关联查询：按 document_id 分组统计 chunk 数
    const rows = await this.chunkRepo
      .createQueryBuilder('c')
      .select('c.document_id', 'documentId')
      .addSelect('COUNT(*)', 'chunkCount')
      .where('c.kb_id = :kbId', { kbId })
      .groupBy('c.document_id')
      .getRawMany<{ documentId: string; chunkCount: string }>();

    if (rows.length === 0) return [];

    const docIds = rows.map((r) => r.documentId);
    const docs = await this.docRepo.find({ where: { id: In(docIds) } });
    const docMap = new Map(docs.map((d) => [d.id, d]));

    return rows.map((r) => {
      const doc = docMap.get(r.documentId);
      return {
        documentId: r.documentId,
        title: doc?.title ?? '(文档已删除)',
        format: doc?.format ?? '',
        chunkCount: Number(r.chunkCount),
      };
    });
  }

  /**
   * 获取知识库的 chunk 统计
   */
  async getStats(kbId: string): Promise<{
    documentCount: number;
    chunkCount: number;
    embeddedCount: number;
  }> {
    const kb = await this.findOne(kbId);
    // 统计已生成 embedding 的 chunk 数
    const result = await this.entityManager.query(
      `SELECT COUNT(*) AS cnt FROM kb_chunks WHERE kb_id = $1 AND embedding IS NOT NULL`,
      [kbId],
    );
    return {
      documentCount: kb.documentCount,
      chunkCount: kb.chunkCount,
      embeddedCount: Number(result?.[0]?.cnt ?? 0),
    };
  }

  /**
   * 获取单个 chunk 的完整内容（引用预览用）
   *
   * 安全：校验 chunk 属于指定 kbId，防止跨知识库越权读取。
   * 不返回 embedding 列（体积大且无业务意义）。
   */
  async getChunk(kbId: string, chunkId: string): Promise<{
    id: string;
    documentId: string;
    chunkIndex: number;
    content: string;
    headingPath: string | null;
    parentChunkId: string | null;
  }> {
    await this.findOne(kbId); // 校验 KB 存在
    const chunk = await this.chunkRepo.findOne({
      where: { id: chunkId, kbId },
    });
    if (!chunk) {
      throw new NotFoundException(`Chunk ${chunkId} 不属于知识库 ${kbId}`);
    }
    return {
      id: chunk.id,
      documentId: chunk.documentId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      headingPath: chunk.headingPath,
      parentChunkId: chunk.parentChunkId,
    };
  }

  /**
   * 导出知识库（对应 TODO 2.2.4：生成后的知识库导出功能）
   *
   * @param kbId 知识库 id
   * @param format 'json' | 'markdown'
   * @returns { filename, content, mime }
   *
   * - json：KB 元数据 + 文档列表 + 全部 chunk（含 headingPath/chunkType/metadata，不含 embedding）
   * - markdown：按文档分组，每个文档的 chunk 按 chunkIndex 拼接为单 markdown，文档间用 level1 标题分隔
   *
   * 安全：embedding 列不导出（体积大且无业务意义）；用 raw SQL 显式列名避免误带 embedding
   */
  async exportKb(
    kbId: string,
    format: 'json' | 'markdown',
  ): Promise<{ filename: string; content: string; mime: string }> {
    const kb = await this.findOne(kbId);
    const docs = await this.listDocuments(kbId);

    // raw SQL 取全部 chunk（显式列名，排除 embedding，避免返回大向量）
    const chunks = await this.entityManager.query(
      `SELECT id, document_id, chunk_index, content, heading_path, parent_chunk_id, chunk_type, metadata, created_at
       FROM kb_chunks WHERE kb_id = $1 ORDER BY document_id, chunk_index`,
      [kbId],
    );

    const safeName = kb.name.replace(/[^\w\u4e00-\u9fa5.-]/g, '_');

    if (format === 'json') {
      const payload = {
        knowledgeBase: {
          id: kb.id,
          name: kb.name,
          description: kb.description,
          embeddingModel: kb.embeddingModel,
          embeddingDimensions: kb.embeddingDimensions,
          chunkStrategy: kb.chunkStrategy,
          retrievalConfig: kb.retrievalConfig,
          documentCount: kb.documentCount,
          chunkCount: kb.chunkCount,
          createdAt: kb.createdAt,
        },
        documents: docs,
        chunks: chunks.map((c: any) => ({
          id: c.id,
          documentId: c.document_id,
          chunkIndex: c.chunk_index,
          content: c.content,
          headingPath: c.heading_path,
          chunkType: c.chunk_type,
          metadata: c.metadata,
          createdAt: c.created_at,
        })),
        exportedAt: new Date().toISOString(),
      };
      return {
        filename: `${safeName}.json`,
        content: JSON.stringify(payload, null, 2),
        mime: 'application/json; charset=utf-8',
      };
    }

    // markdown：按文档分组拼接
    const docMap = new Map(docs.map((d) => [d.documentId, d]));
    const byDoc = new Map<string, typeof chunks>();
    for (const c of chunks) {
      const arr = byDoc.get(c.document_id) ?? [];
      arr.push(c);
      byDoc.set(c.document_id, arr);
    }

    const parts: string[] = [`# ${kb.name}\n`];
    if (kb.description) parts.push(`> ${kb.description}\n`);
    parts.push(`\n> 导出时间：${new Date().toISOString()}  \n> 文档数：${docs.length}  chunk 数：${chunks.length}\n`);

    for (const [docId, docChunks] of byDoc) {
      const doc = docMap.get(docId);
      parts.push(`\n---\n\n# 文档：${doc?.title ?? docId}（${doc?.format ?? ''}）\n`);
      for (const c of docChunks) {
        if (c.heading_path) {
          parts.push(`\n## ${c.heading_path}\n`);
        }
        parts.push(`\n${c.content}\n`);
      }
    }

    return {
      filename: `${safeName}.md`,
      content: parts.join('\n'),
      mime: 'text/markdown; charset=utf-8',
    };
  }

  /**
   * 生成示例问题（R4）
   * 调 LLM 基于文档列表生成 5-10 个测试问题，存到 kb.sample_questions。
   * 前端问答页展示为快捷入口，用户点击直接发起提问。
   *
   * 设计参考：
   * - Yuxi `sample_question_utils.py:generate_database_sample_questions`
   * - 用途：① 推荐问题降低用户冷启动成本 ② 作为评估数据集 seed
   *
   * 失败处理：LLM 未就绪/生成失败时抛错，由 controller 转 HTTP 响应
   */
  async generateSampleQuestions(kbId: string, count = 6): Promise<string[]> {
    const kb = await this.findOne(kbId);
    if (!this.llmService?.isReady()) {
      throw new BadRequestException('AI 服务未启用，无法生成示例问题');
    }

    // 取文档列表（标题 + 格式 + chunk 数）
    const docs = await this.listDocuments(kbId);
    if (docs.length === 0) {
      throw new BadRequestException('知识库无文档，无法生成示例问题');
    }

    // 拼文档清单（限制前 50 个，避免 prompt 过长）
    const docList = docs.slice(0, 50).map((d, i) =>
      `${i + 1}. ${d.title}（${d.format}，${d.chunkCount}块）`,
    ).join('\n');

    const prompt = `你是企业知识库助手。根据下方知识库的文档列表，生成 ${count} 个用户可能问的问题。

知识库「${kb.name}」的文档列表：
${docList}

要求：
1. 问题必须是用户实际可能问的，与文档内容相关
2. 问题简洁明了，一句话，不超 30 字
3. 问题覆盖不同文档（不要全集中在一个文档）
4. 问题用简体中文
5. 只输出问题列表，每行一个，不要编号不要额外说明

输出示例：
什么是 RAG 架构？
如何配置检索策略？`;

    const result = await this.llmService.chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.7, maxTokens: 512, enableThinking: false },
    );
    if (!result?.content) {
      throw new BadRequestException('生成示例问题失败，请稍后重试');
    }

    // 解析：按行分割，去空行，去可能的前导序号
    const questions = result.content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('```'))
      .map((l) => l.replace(/^\d+[.、)]\s*/, '')) // 去 "1. " / "1、 " / "1) "
      .slice(0, count);

    if (questions.length === 0) {
      throw new BadRequestException('生成示例问题为空，请稍后重试');
    }

    // 存到 KB
    kb.sampleQuestions = questions;
    await this.kbRepo.save(kb);
    this.logger.log(`生成 ${questions.length} 个示例问题 kb=${kbId.slice(0, 8)}`);
    return questions;
  }
}

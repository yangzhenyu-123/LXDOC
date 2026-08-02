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
    const kb = await this.findOne(kbId);
    const doc = await this.docRepo.findOne({ where: { id: documentId } });
    if (!doc) throw new NotFoundException(`文档 ${documentId} 不存在`);

    // 查旧 chunk 数（判断文档是否已在 KB + 计算 chunkCount 差值）
    const oldChunkCount = await this.chunkRepo.count({
      where: { kbId, documentId },
    });
    const isExistingDoc = oldChunkCount > 0;

    // 若文档已在此 KB，先清除旧 chunk（重新切分）
    await this.chunkRepo.delete({ kbId, documentId });

    // 文档正文为空（仅预览型格式如 doc/xls），无法加入
    if (!doc.content || !doc.content.trim()) {
      throw new BadRequestException(
        `文档 ${doc.title} 无可解析正文（format=${doc.format}），无法加入知识库`,
      );
    }

    // 1. chunking
    const strategy = kb.chunkStrategy as Partial<ChunkStrategy> | undefined;
    const chunkResults = this.chunkingService.chunk(doc.content, strategy);
    if (chunkResults.length === 0) {
      throw new BadRequestException(`文档 ${doc.title} 切分后无有效 chunk`);
    }

    // 2. embedding 批量生成
    const texts = chunkResults.map((c) => c.content);
    const vectors = await this.embeddingService.embedBatch(texts);
    const successCount = vectors.filter(Boolean).length;
    this.logger.log(
      `文档 ${doc.title} embedding：${successCount}/${chunkResults.length} 成功`,
    );

    // 3. 入库（raw SQL 写 embedding 列，TypeORM 不直接映射 vector 类型）
    await this.entityManager.transaction(async (manager) => {
      // 先批量插入 chunk（不含 embedding）
      // 注意：@PrimaryColumn + default 不会让 TypeORM save 后回填 id，
      //       此处主动生成 uuid，确保后续 UPDATE embedding 能定位到行。
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
      // 批量构造 VALUES：逐条 UPDATE 在 32 条以内可接受
      for (let i = 0; i < saved.length; i++) {
        const vec = vectors[i];
        if (!vec || vec.length === 0) continue;
        // 向量格式：'[0.1,0.2,...]'::vector
        const vecLiteral = `[${vec.join(',')}]`;
        await manager.query(
          `UPDATE kb_chunks SET embedding = $1::vector WHERE id = $2`,
          [vecLiteral, saved[i].id],
        );
      }

      // 更新 KB 计数（T7 修复）
      // documentCount：仅新文档加入时 +1，重复加入不递增
      if (!isExistingDoc) {
        await manager.getRepository(KnowledgeBase).increment(
          { id: kbId },
          'documentCount',
          1,
        );
      }
      // chunkCount：累加差值（新 - 旧），支持重新切分时 chunk 数变化
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
   */
  async removeDocument(kbId: string, documentId: string): Promise<void> {
    const result = await this.chunkRepo.delete({ kbId, documentId });
    if (result.affected && result.affected > 0) {
      await this.kbRepo.decrement({ id: kbId }, 'documentCount', 1);
      await this.kbRepo.decrement({ id: kbId }, 'chunkCount', result.affected);
      this.logger.log(`文档 ${documentId} 从知识库 ${kbId} 移除（${result.affected} chunk）`);
    }
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

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { KnowledgeBase } from './entities/knowledge-base.entity';
import { KbChunk, ChunkType } from './entities/kb-chunk.entity';
import { Document } from '../documents/document.entity';
import { ChunkingService, ChunkResult, ChunkStrategy } from './chunking.service';
import { EmbeddingService } from './embedding.service';

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
  ) {}

  // ========== 知识库 CRUD ==========

  async create(input: {
    name: string;
    description?: string;
    categoryId?: string;
    chunkStrategy?: Partial<ChunkStrategy>;
    createdBy: string;
  }): Promise<KnowledgeBase> {
    const kb = this.kbRepo.create({
      name: input.name,
      description: input.description ?? null,
      categoryId: input.categoryId ?? null,
      chunkStrategy: input.chunkStrategy ?? {},
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

  async update(id: string, input: Partial<Pick<KnowledgeBase, 'name' | 'description' | 'categoryId' | 'chunkStrategy' | 'retrievalConfig'>>): Promise<KnowledgeBase> {
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
}

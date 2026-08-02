import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 知识库实体
 *
 * 一个知识库绑定一个分类（可选），包含若干文档（通过 kb_chunks 关联 documents 表）。
 * 知识库级配置：embedding 模型、维度、chunk 策略、检索策略。
 *
 * 表名 kb_knowledge_bases（复数，与现有 documents/categories 风格一致）。
 */
@Entity('kb_knowledge_bases')
export class KnowledgeBase {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 关联分类（可选，知识库可绑定某分类节点，仅索引该分类下文档） */
  @Index()
  @Column({ name: 'category_id', type: 'uuid', nullable: true })
  categoryId: string | null;

  /** embedding 模型标识（如 BAAI/bge-m3） */
  @Column({
    name: 'embedding_model',
    type: 'varchar',
    length: 100,
    default: 'BAAI/bge-m3',
  })
  embeddingModel: string;

  /** 向量维度（bge-m3 = 1024，建表时据此创建 vector(N) 列） */
  @Column({ name: 'embedding_dimensions', type: 'int', default: 1024 })
  embeddingDimensions: number;

  /**
   * chunk 切分策略（JSONB）
   * { strategy: 'markdown_structure', chunkSize: 512, overlap: 64 }
   */
  @Column({ name: 'chunk_strategy', type: 'jsonb', default: '{}' })
  chunkStrategy: Record<string, any>;

  /**
   * 检索策略（JSONB）
   * { vectorTopK: 20, trgmTopK: 20, rrfK: 60, rerank: false }
   */
  @Column({ name: 'retrieval_config', type: 'jsonb', default: '{}' })
  retrievalConfig: Record<string, any>;

  /**
   * 示例问题（JSONB，R4 自动生成）
   * LLM 基于文档列表生成 5-10 个测试问题，前端问答页展示为快捷入口
   * 数组结构：string[]，如 ["什么是 RAG？", "如何配置检索？"]
   */
  @Column({ name: 'sample_questions', type: 'jsonb', default: '[]' })
  sampleQuestions: string[];

  /** 文档总数（冗余计数，避免每次 COUNT(*) 查询） */
  @Column({ name: 'document_count', type: 'int', default: 0 })
  documentCount: number;

  /** chunk 总数（冗余计数） */
  @Column({ name: 'chunk_count', type: 'int', default: 0 })
  chunkCount: number;

  /** 创建者 */
  @Index()
  @Column({ name: 'created_by', type: 'uuid' })
  createdBy: string;

  /**
   * 是否要求入库审核
   * - false（默认）：addDocument 直接入库（向后兼容，admin/editor 均可）
   * - true         ：组员 addDocument 走审核流（创建入库申请 → 审核 → 入库）
   *                 admin 仍可通过原端点直接入库（绕过审核）
   */
  @Column({
    name: 'require_review',
    type: 'boolean',
    default: false,
  })
  requireReview: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

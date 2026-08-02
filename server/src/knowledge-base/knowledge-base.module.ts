import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KnowledgeBase } from './entities/knowledge-base.entity';
import { KbChunk } from './entities/kb-chunk.entity';
import { MessageFeedback } from './entities/message-feedback.entity';
import { Document } from '../documents/document.entity';
import { KnowledgeBaseController } from './knowledge-base.controller';
import { KnowledgeBaseService } from './knowledge-base.service';
import { ChunkingService } from './chunking.service';
import { EmbeddingService } from './embedding.service';
import { RerankService } from './rerank.service';
import { RetrievalService } from './retrieval.service';
import { RagService } from './rag.service';
import { RagPromptService } from './rag-prompt.service';
import { FeedbackService } from './feedback.service';
import { LlmModule } from '../llm/llm.module';

/**
 * 知识库模块（RAG 向量检索 + 问答）
 *
 * P0-P1: 实体 + 索引就绪
 * P2: 知识库 CRUD + 文档加入/移出（chunking + embedding + 入库）
 * P3: 混合检索 + RRF
 * P4: RAG 问答（检索 → prompt → GLM 流式 → 引用）
 * P8: rerank（cross-encoder 二次排序）
 * P9: 消息反馈（点赞/点踩存表用于 RAG 质量评估）
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([KnowledgeBase, KbChunk, MessageFeedback, Document]),
    LlmModule,
  ],
  controllers: [KnowledgeBaseController],
  providers: [
    KnowledgeBaseService,
    ChunkingService,
    EmbeddingService,
    RerankService,
    RetrievalService,
    RagPromptService,
    RagService,
    FeedbackService,
  ],
  exports: [
    KnowledgeBaseService,
    ChunkingService,
    EmbeddingService,
    RerankService,
    RetrievalService,
    RagService,
  ],
})
export class KnowledgeBaseModule {}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/user.entity';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { KnowledgeBaseService } from './knowledge-base.service';
import { RetrievalService } from './retrieval.service';
import { RagService } from './rag.service';
import { FeedbackService } from './feedback.service';
import { CreateKbDto, UpdateKbDto, AddDocumentDto, RetrieveDto, AskDto } from './dto/kb.dto';
import { CreateFeedbackDto } from './dto/feedback.dto';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-log.entity';

/**
 * 知识库管理 API
 *
 * 读操作：所有登录用户可访问
 * 写操作（create/update/remove/addDocument/removeDocument/export）：仅 admin
 * 审计：所有写操作记录到 audit_logs（对应 TODO 2.3：高权限操作留痕，防数据污染）
 */
@ApiTags('知识库 KnowledgeBase')
@ApiBearerAuth('access-token')
@Controller('knowledge-bases')
export class KnowledgeBaseController {
  constructor(
    private readonly kbService: KnowledgeBaseService,
    private readonly retrievalService: RetrievalService,
    private readonly ragService: RagService,
    private readonly feedbackService: FeedbackService,
    private readonly auditService: AuditService,
  ) {}

  // ========== 读操作 ==========

  @ApiOperation({ summary: '列出全部知识库' })
  @Get()
  findAll() {
    return this.kbService.findAll();
  }

  @ApiOperation({ summary: '查看知识库详情' })
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.kbService.findOne(id);
  }

  @ApiOperation({ summary: '查看知识库统计（文档数/chunk数/embedding数）' })
  @Get(':id/stats')
  getStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.kbService.getStats(id);
  }

  @ApiOperation({ summary: '列出知识库中的文档' })
  @Get(':id/documents')
  listDocuments(@Param('id', ParseUUIDPipe) id: string) {
    return this.kbService.listDocuments(id);
  }

  @ApiOperation({ summary: '混合检索（向量+词法+RRF）' })
  @Get(':id/retrieve')
  retrieve(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('query') query: string,
    @Query('topK') topK?: string,
    @Query('documentIds') documentIds?: string,
  ) {
    const docFilter = documentIds
      ? documentIds.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const config = {
      ...(topK ? { finalTopK: Number(topK) } : {}),
      ...(docFilter && docFilter.length > 0 ? { documentIds: docFilter } : {}),
    };
    return this.retrievalService.retrieve(id, query, config);
  }

  @ApiOperation({ summary: '获取 chunk 完整内容（引用预览）' })
  @Get(':id/chunks/:chunkId')
  getChunk(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('chunkId', ParseUUIDPipe) chunkId: string,
  ) {
    return this.kbService.getChunk(id, chunkId);
  }

  @ApiOperation({ summary: '导出知识库（json/markdown，admin）' })
  @Roles(UserRole.ADMIN)
  @Get(':id/export')
  async exportKb(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('format') format: 'json' | 'markdown' = 'json',
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    const fmt = format === 'markdown' ? 'markdown' : 'json';
    const result = await this.kbService.exportKb(id, fmt);
    await this.auditService.log({
      userId: user.id,
      action: AuditAction.KB_EXPORT,
      target: { type: 'knowledge_base', id },
      detail: { format: fmt, filename: result.filename },
    });
    res.setHeader('Content-Type', result.mime);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
    );
    res.send(result.content);
  }

  @ApiOperation({ summary: '生成示例问题（R4，LLM 基于文档列表生成）' })
  // H10 修复：LLM 接口收紧限流（10 次/分钟/用户），防资源滥用与刷量
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/sample-questions')
  async generateSampleQuestions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('count') count?: number,
  ): Promise<string[]> {
    return this.kbService.generateSampleQuestions(id, count);
  }

  @ApiOperation({ summary: 'RAG 问答（SSE 流式）' })
  // H10 修复：RAG 问答限流（5 次/分钟/用户），SSE 流式调用成本高，防并发刷量拖垮 LLM 网关
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':id/ask')
  async ask(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AskDto,
    @Res() res: Response,
  ): Promise<void> {
    // SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 防 nginx 缓冲
    res.flushHeaders();

    // 中断信号：客户端断开时 abort
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    try {
      for await (const event of this.ragService.ask(id, dto.query, controller.signal, {
        history: dto.history,
        documentIds: dto.documentIds,
      })) {
        // SSE 格式：data: {json}\n\n
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        // 检测客户端是否已断开
        if (controller.signal.aborted) break;
      }
    } catch (err) {
      // 兜底错误（ragService 内部已处理大部分，这里只防未捕获异常）
      res.write(
        `data: ${JSON.stringify({ type: 'error', message: '生成失败，请稍后重试' })}\n\n`,
      );
    } finally {
      res.end();
    }
  }

  // ========== P9 候选 3：消息反馈 ==========

  @ApiOperation({ summary: '提交 RAG 回答反馈（点赞/点踩）' })
  @Post('feedback')
  @HttpCode(201)
  async createFeedback(
    @Body() dto: CreateFeedbackDto,
    @CurrentUser() user: AuthUser,
  ): Promise<{ id: string; rating: number }> {
    const fb = await this.feedbackService.create(
      user.id,
      dto.messageId,
      dto.kbId,
      dto.rating,
      dto.reason,
    );
    return { id: fb.id, rating: fb.rating };
  }

  // ========== 写操作（admin） ==========

  @ApiOperation({ summary: '创建知识库' })
  @Roles(UserRole.ADMIN)
  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateKbDto, @CurrentUser() user: AuthUser) {
    const kb = await this.kbService.create({
      name: dto.name,
      description: dto.description,
      categoryId: dto.categoryId,
      chunkStrategy: dto.chunkStrategy,
      requireReview: dto.requireReview,
      createdBy: user.id,
    });
    await this.auditService.log({
      userId: user.id,
      action: AuditAction.KB_CREATE,
      target: { type: 'knowledge_base', id: kb.id },
      detail: { name: dto.name },
    });
    return kb;
  }

  @ApiOperation({ summary: '更新知识库' })
  @Roles(UserRole.ADMIN)
  @Put(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKbDto,
    @CurrentUser() user: AuthUser,
  ) {
    const kb = await this.kbService.update(id, dto);
    await this.auditService.log({
      userId: user.id,
      action: AuditAction.KB_UPDATE,
      target: { type: 'knowledge_base', id },
      detail: { fields: Object.keys(dto) },
    });
    return kb;
  }

  @ApiOperation({ summary: '删除知识库（含其全部 chunk）' })
  @Roles(UserRole.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.kbService.remove(id);
    await this.auditService.log({
      userId: user.id,
      action: AuditAction.KB_DELETE,
      target: { type: 'knowledge_base', id },
    });
  }

  @ApiOperation({ summary: '将文档加入知识库（触发切分+embedding 入库）' })
  @Roles(UserRole.ADMIN)
  @Post(':id/documents')
  @HttpCode(201)
  async addDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    const chunkCount = await this.kbService.addDocument(id, dto.documentId);
    await this.auditService.log({
      userId: user.id,
      action: AuditAction.KB_DOCUMENT_ADD,
      target: { type: 'knowledge_base', id },
      detail: { documentId: dto.documentId, chunkCount },
    });
    return { chunkCount };
  }

  @ApiOperation({ summary: '从知识库移除文档' })
  @Roles(UserRole.ADMIN)
  @Delete(':id/documents/:documentId')
  @HttpCode(204)
  async removeDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.kbService.removeDocument(id, documentId);
    await this.auditService.log({
      userId: user.id,
      action: AuditAction.KB_DOCUMENT_REMOVE,
      target: { type: 'knowledge_base', id },
      detail: { documentId },
    });
  }
}

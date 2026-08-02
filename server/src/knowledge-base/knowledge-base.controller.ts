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
import { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/user.entity';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { KnowledgeBaseService } from './knowledge-base.service';
import { RetrievalService } from './retrieval.service';
import { RagService } from './rag.service';
import { CreateKbDto, UpdateKbDto, AddDocumentDto, RetrieveDto, AskDto } from './dto/kb.dto';

/**
 * 知识库管理 API
 *
 * 读操作：所有登录用户可访问
 * 写操作（create/update/remove/addDocument/removeDocument）：仅 admin
 */
@ApiTags('知识库 KnowledgeBase')
@ApiBearerAuth('access-token')
@Controller('knowledge-bases')
export class KnowledgeBaseController {
  constructor(
    private readonly kbService: KnowledgeBaseService,
    private readonly retrievalService: RetrievalService,
    private readonly ragService: RagService,
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
  ) {
    const config = topK ? { finalTopK: Number(topK) } : undefined;
    return this.retrievalService.retrieve(id, query, config);
  }

  @ApiOperation({ summary: 'RAG 问答（SSE 流式）' })
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
      for await (const event of this.ragService.ask(id, dto.query, controller.signal)) {
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

  // ========== 写操作（admin） ==========

  @ApiOperation({ summary: '创建知识库' })
  @Roles(UserRole.ADMIN)
  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateKbDto, @CurrentUser() user: AuthUser) {
    return this.kbService.create({
      name: dto.name,
      description: dto.description,
      categoryId: dto.categoryId,
      chunkStrategy: dto.chunkStrategy,
      createdBy: user.id,
    });
  }

  @ApiOperation({ summary: '更新知识库' })
  @Roles(UserRole.ADMIN)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKbDto,
  ) {
    return this.kbService.update(id, dto);
  }

  @ApiOperation({ summary: '删除知识库（含其全部 chunk）' })
  @Roles(UserRole.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.kbService.remove(id);
  }

  @ApiOperation({ summary: '将文档加入知识库（触发切分+embedding 入库）' })
  @Roles(UserRole.ADMIN)
  @Post(':id/documents')
  @HttpCode(201)
  async addDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddDocumentDto,
  ) {
    const chunkCount = await this.kbService.addDocument(id, dto.documentId);
    return { chunkCount };
  }

  @ApiOperation({ summary: '从知识库移除文档' })
  @Roles(UserRole.ADMIN)
  @Delete(':id/documents/:documentId')
  @HttpCode(204)
  async removeDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    await this.kbService.removeDocument(id, documentId);
  }
}

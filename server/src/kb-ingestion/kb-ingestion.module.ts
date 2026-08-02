import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KbIngestionRequest } from './entities/kb-ingestion-request.entity';
import { KbIngestionReview } from './entities/kb-ingestion-review.entity';
import { Organization } from '../organizations/organization.entity';
import { UserOrgRole } from '../organizations/user-org-role.entity';
import { KnowledgeBase } from '../knowledge-base/entities/knowledge-base.entity';
import { Document } from '../documents/document.entity';
import { KbIngestionController } from './kb-ingestion.controller';
import { KbIngestionService } from './kb-ingestion.service';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';
import { NotificationModule } from '../notifications/notification.module';
import { AuditModule } from '../audit/audit.module';

/**
 * 知识库入库审核模块
 *
 * 依赖：
 * - KnowledgeBaseModule：调用 addDocument 触发实际入库
 * - NotificationModule：发站内通知（审核人/申请人）
 * - AuditModule：审计日志（创建/通过/拒绝/撤销）
 *
 * 自己注册 KbIngestionRequest/Review + Organization/UserOrgRole/KnowledgeBase/Document
 * （后四个为只读查询用，与各自模块共存无冲突）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      KbIngestionRequest,
      KbIngestionReview,
      Organization,
      UserOrgRole,
      KnowledgeBase,
      Document,
    ]),
    KnowledgeBaseModule,
    NotificationModule,
    AuditModule,
  ],
  controllers: [KbIngestionController],
  providers: [KbIngestionService],
  exports: [KbIngestionService],
})
export class KbIngestionModule {}

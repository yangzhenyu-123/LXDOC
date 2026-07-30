import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './audit-log.entity';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuditInterceptor } from './audit.interceptor';

/**
 * 审计日志模块
 * - 注册 AuditLog 实体 Repository
 * - 提供 AuditService（写入 + 查询）与 AuditInterceptor（全局拦截器）
 * - 导出 AuditService 供其他模块写入审计日志
 * - 导出 AuditInterceptor 供 AppModule 注册为 APP_INTERCEPTOR
 *   AuditInterceptor 依赖 AuditService，由本模块同模块内可直接注入
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [AuditService, AuditInterceptor],
  controllers: [AuditController],
  exports: [AuditService, AuditInterceptor],
})
export class AuditModule {}

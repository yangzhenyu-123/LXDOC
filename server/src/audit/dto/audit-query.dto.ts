import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction } from '../audit-log.entity';

/**
 * 审计日志查询 DTO
 * - userId：按操作人筛选（uuid）
 * - action：按动作筛选（AuditAction 枚举）
 * - startDate / endDate：按 createdAt 时间范围筛选（ISO 8601 日期字符串）
 * - page / pageSize：分页参数，page>=1，pageSize 1~100
 * 由全局 ValidationPipe（transform: true）将 query string 自动转为对应类型
 */
export class AuditQueryDto {
  @ApiPropertyOptional({ description: '操作人用户 id', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: '审计动作', enum: AuditAction, example: 'login' })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({ description: '起始时间（ISO 8601）', example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: '结束时间（ISO 8601）', example: '2026-12-31T23:59:59.000Z' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: '页码（最小 1）', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（1-100）', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

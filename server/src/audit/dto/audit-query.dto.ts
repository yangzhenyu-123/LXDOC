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
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

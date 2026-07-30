import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

/**
 * 全文检索查询参数 DTO
 * - q：关键词，1~100 字符
 * - page：页码，最小 1，默认 1
 * - pageSize：每页条数，最小 1，默认 20
 */
export class SearchQueryDto {
  @IsString()
  @Length(1, 100)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number = 20;
}

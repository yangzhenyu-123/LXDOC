import { ApiProperty } from '@nestjs/swagger';

/**
 * 分类响应 DTO
 * 树形结构：顶层节点 children 数组递归包含子节点
 */
export class CategoryResponseDto {
  @ApiProperty({ description: '分类 id', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  id: string;

  @ApiProperty({ description: '父级分类 id（顶层为 null）', example: null, nullable: true })
  parentId: string | null;

  @ApiProperty({ description: '分类名称', example: '前端指南' })
  name: string;

  @ApiProperty({ description: '分类类型（字符串，子分类可能为 null）', example: 'tech_doc', nullable: true })
  type: string | null;

  @ApiProperty({ description: '排序值', example: 0 })
  sort: number;

  @ApiProperty({ description: '创建时间', example: '2026-01-01T00:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ description: '子分类列表（递归）', type: () => [CategoryResponseDto], example: [] })
  children: CategoryResponseDto[];
}

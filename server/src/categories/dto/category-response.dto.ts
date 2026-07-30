import { CategoryType } from '../category.entity';

/**
 * 分类响应 DTO
 * 树形结构：顶层节点 children 数组递归包含子节点
 */
export class CategoryResponseDto {
  id: string;
  parentId: string | null;
  name: string;
  type: CategoryType | null;
  sort: number;
  createdAt: Date;
  children: CategoryResponseDto[];
}

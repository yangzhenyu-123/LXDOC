import client from './client';

// 分类类型，与后端 CategoryType 枚举对齐
export type CategoryType = 'tech_doc' | 'solution' | 'bug_report';

// 分类节点（树形递归）
export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  type?: CategoryType | null;
  sort: number;
  createdAt: string;
  children?: Category[];
}

export interface CreateCategoryPayload {
  parentId?: string | null;
  name: string;
  type?: CategoryType;
  sort?: number;
}

export interface UpdateCategoryPayload {
  name?: string;
  sort?: number;
}

// 获取分类树
export function getCategoriesTree(): Promise<Category[]> {
  return client.get<Category, Category[]>('/categories');
}

// 创建分类
export function createCategory(
  dto: CreateCategoryPayload,
): Promise<Category> {
  return client.post<Category, Category>('/categories', dto);
}

// 更新分类
export function updateCategory(
  id: string,
  dto: UpdateCategoryPayload,
): Promise<Category> {
  return client.patch<Category, Category>(`/categories/${id}`, dto);
}

// 删除分类
export function deleteCategory(id: string): Promise<void> {
  return client.delete<void, void>(`/categories/${id}`);
}

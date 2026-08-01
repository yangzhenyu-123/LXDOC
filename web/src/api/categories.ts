import client from './client';

/**
 * 分类类型（字符串，与后端 varchar(50) 对齐，支持任意自定义类型名）
 * 预定义类型常量供配色/排序使用，但 type 不限于此列表。
 *
 * 顺序即默认展示排序（HomeView 的 sortedTopCategories 依赖此顺序）：
 *   入门(新人/规范) → 日常核心(技术/方案/公共) → 项目 → 技术基础
 *   → 问题排查(bug 三类聚拢) → 培训
 */
export const CategoryTypes = {
  NEWCOMER: 'newcomer',
  REGULATION: 'regulation',
  TECH_DOC: 'tech_doc',
  SOLUTION: 'solution',
  DEPT_PUBLIC: 'dept_public',
  KEY_PROJECT: 'key_project',
  OS_KNOWLEDGE: 'os_knowledge',
  BUG_REPORT: 'bug_report',
  KEY_BUG: 'key_bug',
  ENG_ISSUES: 'eng_issues',
  TRAINING: 'training',
} as const;

// 分类类型为字符串，不再受枚举约束
export type CategoryType = string;

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
  type?: string;
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

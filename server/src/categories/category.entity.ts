import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * 分类类型常量（向后兼容，仅用于种子数据与默认配色映射）
 * type 列已改为 varchar(50)，不再受 DB enum 约束，支持任意自定义类型名。
 * 新建顶层分类时传入任意字符串 type 即可。
 *
 * 顺序即默认展示排序（入门 → 日常核心 → 项目 → 技术基础 → 问题排查 → 培训），
 * bug 三类聚拢，新人入门提前。
 */
export const CategoryType = {
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

/** 分类类型值（字符串，不再受 enum 约束） */
export type CategoryTypeValue = (typeof CategoryType)[keyof typeof CategoryType];

/**
 * 分类实体
 * 通过 parent_id 实现自引用树形结构，顶层分类 parent_id 为 null
 */
@Entity('categories')
export class Category {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  // 父级分类 id，顶层分类为 null；加索引以加速树查询
  @Index()
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId: string | null;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  // 分类类型：varchar(50)，顶层必填，子分类可为 null（继承父级）
  // 不再使用 DB enum 约束，支持任意自定义类型名；前端配色按 type 名映射，未知用默认色
  @Column({ name: 'type', type: 'varchar', length: 50, nullable: true })
  type: string | null;

  @Column({ type: 'int', default: 0 })
  sort: number;

  // 创建者用户 id（关联 users.id），用于权限判断
  @Index()
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  // 所属组织节点 id；null 表示全站公共分类树（种子顶层分类为 null）
  @Index()
  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

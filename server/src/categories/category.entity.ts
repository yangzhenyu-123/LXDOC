import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * 分类类型枚举
 * 仅顶层分类必填，子分类继承父级 type（字段本身可为 null）
 */
export enum CategoryType {
  TECH_DOC = 'tech_doc',
  SOLUTION = 'solution',
  BUG_REPORT = 'bug_report',
}

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

  // 分类类型：顶层必填，子分类可为 null（继承父级）
  @Column({ name: 'type', type: 'enum', enum: CategoryType, nullable: true })
  type: CategoryType | null;

  @Column({ type: 'int', default: 0 })
  sort: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

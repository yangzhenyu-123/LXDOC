import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 组织节点类型
 * - department: 部门（顶层节点，parent 为 null）
 * - group: 组（部门下的子节点，必须有 parent）
 */
export enum OrganizationType {
  DEPARTMENT = 'department',
  GROUP = 'group',
}

/**
 * 组织实体（通用树）
 * 通过 parent_id 自引用实现 部门 > 组 的层级；个人空间为用户私有，不建节点。
 *
 * path 为物化路径，段之间以 '.' 分隔，每段使用节点 id（UUID），保证唯一、无需 slug 去重。
 * 例：部门 "研发部" path = "<uuid>"，其下组 "前端组" path = "<dept-uuid>.<group-uuid>"。
 *
 * 读 ACL 用前缀匹配：owner.path 是 user.orgPath 的前缀时，用户可读（用户位于 owner 节点或其子树）。
 */
@Entity('organizations')
@Index(['parentId'])
@Index(['path'])
export class Organization {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  // 父节点 id，顶层部门为 null
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId: string | null;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'enum', enum: OrganizationType })
  type: OrganizationType;

  // 物化路径：顶层为自身 id，子节点为 `${parent.path}.${id}`
  @Column({ type: 'varchar', length: 2048 })
  path: string;

  @Column({ type: 'int', default: 0 })
  sort: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

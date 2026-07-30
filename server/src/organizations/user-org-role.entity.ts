import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';

/**
 * 用户在某组织节点的角色（编辑授权）
 * - editor: 可编辑该节点及其子树下的文档
 * - admin: 可编辑 + 可管理该节点成员与子节点
 *
 * 全局 UserRole.ADMIN 不受此表约束（全权）。
 * 同一 (userId, orgId) 唯一，避免重复授权。
 */
export enum UserOrgRoleValue {
  EDITOR = 'editor',
  ADMIN = 'admin',
}

@Entity('user_org_roles')
@Unique('uq_user_org', ['userId', 'orgId'])
@Index(['userId'])
@Index(['orgId'])
export class UserOrgRole {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'org_id', type: 'uuid' })
  orgId: string;

  @Column({ type: 'enum', enum: UserOrgRoleValue })
  role: UserOrgRoleValue;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

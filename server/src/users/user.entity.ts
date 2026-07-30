import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 用户角色枚举
 * - admin: 管理员，拥有全部权限
 * - editor: 编辑者，可读写上传
 * - viewer: 只读用户
 */
export enum UserRole {
  ADMIN = 'admin',
  EDITOR = 'editor',
  VIEWER = 'viewer',
}

/**
 * 用户状态枚举
 * - active: 启用
 * - disabled: 禁用
 */
export enum UserStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

/**
 * 用户实体
 * email / username 唯一索引；passwordHash 用 select:false 默认查询不返回
 * 需要密码字段时用 addSelect('user.password_hash') 显式取出
 */
@Entity('users')
@Index(['email'], { unique: true })
@Index(['username'], { unique: true })
export class User {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ type: 'varchar', length: 200 })
  email: string;

  @Column({ type: 'varchar', length: 100 })
  username: string;

  // select:false 默认查询不返回密码哈希，需要时显式 addSelect
  @Column({ name: 'password_hash', type: 'varchar', length: 200, select: false })
  passwordHash: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.VIEWER })
  role: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  // 所属组织节点 id（通常指向某个 group；全局 admin 为 null）
  @Index()
  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

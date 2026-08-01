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

  // 用户选择的 LLM 配置套（admin 预配置的多套 LLM 之一）；null 表示用全局默认
  // 保留向后兼容，新逻辑改用下方用户级 LLM 字段
  @Index()
  @Column({ name: 'llm_config_id', type: 'uuid', nullable: true })
  llmConfigId: string | null;

  // ============ 用户级 LLM 配置（每人配自己的 baseUrl/apiKey/model） ============
  // 普通用户必须自己配置才能使用 AI；admin 未配时回退系统配置 llm.*

  /** LLM 服务端点（OpenAI 兼容），如 http://<LLM_HOST>/v1/ */
  @Column({ name: 'llm_base_url', type: 'varchar', length: 500, nullable: true })
  llmBaseUrl: string | null;

  /** LLM 调用密钥（内网若无需鉴权可留空）；select:false 默认查询不返回 */
  @Column({ name: 'llm_api_key', type: 'varchar', length: 200, nullable: true, select: false })
  llmApiKey: string | null;

  /** LLM 模型名，如 zai-org/GLM-5.2-FP8 */
  @Column({ name: 'llm_model', type: 'varchar', length: 100, nullable: true })
  llmModel: string | null;

  /** 是否启用推理模式（GLM-5.2 等推理模型可关闭以加速简单任务） */
  @Column({ name: 'llm_enable_thinking', type: 'boolean', default: true })
  llmEnableThinking: boolean;

  /**
   * admin 代理身份：指向另一用户的 id。
   * 设置后 admin 调用 AI 时实际使用该用户的 LLM 配置（方便测试不同用户的配置）。
   * 仅 admin 可设置；普通用户忽略此字段。
   */
  @Index()
  @Column({ name: 'llm_act_as_user_id', type: 'uuid', nullable: true })
  llmActAsUserId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

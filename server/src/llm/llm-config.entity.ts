import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * LLM 配置套（admin 可创建多套，用户选择使用其中一套）
 *
 * 设计：全局 .env 的 LLM_* 作为默认配置（system_settings 可在线改），
 * admin 可额外创建多套 LLM 配置（如不同模型/不同端点），分配给不同用户组使用。
 * 用户在个人设置中选择 llmConfigId，调用 AI 功能时优先用所选配置，回退全局默认。
 * 全局 LLM 不开放给个人自配，防止限速与密钥泄露。
 */
@Entity('llm_configs')
export class LlmConfig {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'base_url', type: 'varchar', length: 500 })
  baseUrl: string;

  @Column({ name: 'api_key', type: 'varchar', length: 200, nullable: true })
  apiKey: string | null;

  @Column({ name: 'model', type: 'varchar', length: 100 })
  model: string;

  /** 是否启用推理模式（GLM-5.2 等推理模型可关闭以加速简单任务） */
  @Column({ name: 'enable_thinking', type: 'boolean', default: true })
  enableThinking: boolean;

  /** 是否启用此配置（false 时用户不可选） */
  @Index()
  @Column({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled: boolean;

  /** 创建者（admin） */
  @Index()
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

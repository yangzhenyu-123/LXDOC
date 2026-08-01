import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 系统设置实体（key-value 存储）
 * 存放运行时可在线修改的配置项，service 读取时优先查此表，回退到 .env 默认值。
 * 仅 admin 可修改。键名与配置项对应，如 llm.enabled / llm.baseUrl / auth.allowSignup。
 */
@Entity('system_settings')
export class SystemSetting {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  key: string;

  @Column({ type: 'text', nullable: true })
  value: string | null;

  // 值类型标记：用于反序列化。string/number/boolean
  @Column({ type: 'varchar', length: 20, default: 'string' })
  valueType: 'string' | 'number' | 'boolean';

  @Column({ type: 'varchar', length: 200, nullable: true })
  description: string | null;

  @Index()
  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

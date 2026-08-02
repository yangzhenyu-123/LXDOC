import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmConfig } from './llm-config.entity';
import { User, UserRole } from '../users/user.entity';
import { llmConfig } from '../config/llm.config';

/**
 * LLM 配置管理 Service
 *
 * 新架构（用户级 LLM 配置）：
 * - 每个用户在自己的个人设置中配置 baseUrl/apiKey/model/enableThinking
 * - 普通用户必须自己配置才能使用 AI（不提供全局默认回退）
 * - admin 未配个人 LLM 时回退系统配置 llm.*（系统配置项作为 admin 默认值）
 * - admin 可设置 llmActAsUserId 代理身份，调用 AI 时使用指定用户的配置
 *
 * 保留旧的 llm_configs 表 CRUD（向后兼容），但新逻辑不再依赖它。
 */
@Injectable()
export class LlmConfigService {
  private readonly logger = new Logger(LlmConfigService.name);

  constructor(
    @InjectRepository(LlmConfig)
    private readonly configRepo: Repository<LlmConfig>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  // ============ 用户级 LLM 配置（新架构） ============

  /**
   * 获取当前用户的 LLM 配置（脱敏 apiKey）
   * 用于个人设置页回显
   */
  async getMyLlmConfig(userId: string): Promise<{
    baseUrl: string | null;
    apiKey: string | null; // 脱敏：已配置返回 '******'，未配置返回 null
    model: string | null;
    enableThinking: boolean;
    actAsUserId: string | null;
  }> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'llmBaseUrl', 'llmApiKey', 'llmModel', 'llmEnableThinking', 'llmActAsUserId'],
    });
    if (!user) throw new NotFoundException('用户不存在');
    return {
      baseUrl: user.llmBaseUrl,
      apiKey: user.llmApiKey ? '******' : null,
      model: user.llmModel,
      enableThinking: user.llmEnableThinking,
      actAsUserId: user.llmActAsUserId,
    };
  }

  /**
   * 更新当前用户的 LLM 配置
   * - apiKey 传 '******' 或 undefined 表示不修改（保留原值）
   * - enableThinking 可选
   * - actAsUserId 仅 admin 可设置；普通用户传入会被忽略
   */
  async updateMyLlmConfig(
    userId: string,
    data: {
      baseUrl?: string | null;
      apiKey?: string | null;
      model?: string | null;
      enableThinking?: boolean;
      actAsUserId?: string | null;
    },
  ): Promise<void> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'role', 'llmApiKey'],
    });
    if (!user) throw new NotFoundException('用户不存在');

    const update: Partial<User> = {};
    // H3 修复：baseUrl 仅 admin 可配置 + 协议校验，防止普通用户利用 SSRF 探测内网
    if (data.baseUrl !== undefined) {
      if (user.role !== UserRole.ADMIN) {
        throw new ForbiddenException('仅管理员可配置 LLM baseUrl，普通用户请使用系统默认端点');
      }
      const url = data.baseUrl?.trim();
      if (url) {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new BadRequestException('LLM baseUrl 格式无效');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new BadRequestException('LLM baseUrl 仅支持 http/https 协议');
        }
      }
      update.llmBaseUrl = url || null;
    }
    if (data.model !== undefined) update.llmModel = data.model?.trim() || null;
    if (data.enableThinking !== undefined) update.llmEnableThinking = data.enableThinking;
    // apiKey: '******' 或 undefined 或 '' 视为不修改；其他值更新
    if (data.apiKey !== undefined && data.apiKey !== null && data.apiKey !== '******') {
      update.llmApiKey = data.apiKey.trim() || null;
    }
    // 代理身份仅 admin 可设置
    if (data.actAsUserId !== undefined && user.role === UserRole.ADMIN) {
      if (data.actAsUserId) {
        // 校验目标用户存在
        const target = await this.userRepo.findOne({
          where: { id: data.actAsUserId },
          select: ['id'],
        });
        if (!target) throw new BadRequestException('代理目标用户不存在');
        update.llmActAsUserId = data.actAsUserId;
      } else {
        update.llmActAsUserId = null;
      }
    }

    if (Object.keys(update).length > 0) {
      await this.userRepo.update({ id: userId }, update);
      this.logger.log(`用户 ${userId} 更新 LLM 配置：${Object.keys(update).join(', ')}`);
    }
  }

  /**
   * admin: 获取所有用户的 LLM 配置概览（apiKey 脱敏）
   * 用于 LlmConfigView 管理页
   */
  async getAllUsersLlmOverview(): Promise<
    Array<{
      id: string;
      username: string;
      email: string;
      role: string;
      llmBaseUrl: string | null;
      llmModel: string | null;
      llmApiKeyConfigured: boolean; // 是否已配置 apiKey（不返回实际值）
      llmEnableThinking: boolean;
      llmActAsUserId: string | null;
    }>
  > {
    const users = await this.userRepo.find({
      select: [
        'id',
        'username',
        'email',
        'role',
        'llmBaseUrl',
        'llmModel',
        'llmApiKey',
        'llmEnableThinking',
        'llmActAsUserId',
      ],
      order: { createdAt: 'ASC' },
    });
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      llmBaseUrl: u.llmBaseUrl,
      llmModel: u.llmModel,
      llmApiKeyConfigured: !!u.llmApiKey,
      llmEnableThinking: u.llmEnableThinking,
      llmActAsUserId: u.llmActAsUserId,
    }));
  }

  /**
   * admin: 获取可被代理的用户列表（除自己外的所有用户）
   */
  async getActAsCandidates(excludeUserId: string): Promise<
    Array<{ id: string; username: string; email: string; role: string }>
  > {
    const users = await this.userRepo.find({
      where: { status: 'active' as any },
      select: ['id', 'username', 'email', 'role'],
      order: { username: 'ASC' },
    });
    return users.filter((u) => u.id !== excludeUserId);
  }

  // ============ 解析生效配置 ============

  /**
   * 解析用户最终生效的 LLM 连接配置（供 GlmProvider.chat 的 opts 覆盖）
   *
   * 优先级：
   * 1. admin 设了代理身份 → 返回被代理用户的配置
   * 2. 用户自己配了 baseUrl+model → 返回自己的配置
   * 3. admin 未配个人 → 回退系统配置 llm.*
   * 4. 普通用户未配 → 返回 null（调用方应禁用 AI）
   */
  async resolveForUser(
    userId: string,
  ): Promise<{ baseUrl: string; apiKey: string; model: string; enableThinking: boolean } | null> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: [
        'id',
        'role',
        'llmBaseUrl',
        'llmApiKey',
        'llmModel',
        'llmEnableThinking',
        'llmActAsUserId',
      ],
    });
    if (!user) return null;

    // 1. admin 代理身份优先
    if (user.role === UserRole.ADMIN && user.llmActAsUserId) {
      const target = await this.userRepo.findOne({
        where: { id: user.llmActAsUserId },
        select: ['id', 'llmBaseUrl', 'llmApiKey', 'llmModel', 'llmEnableThinking'],
      });
      if (target?.llmBaseUrl && target?.llmModel) {
        return {
          baseUrl: target.llmBaseUrl,
          apiKey: target.llmApiKey ?? '',
          model: target.llmModel,
          enableThinking: target.llmEnableThinking,
        };
      }
      // 代理目标未配，继续走 admin 自己的逻辑
    }

    // 2. 用户自己配了 baseUrl + model
    if (user.llmBaseUrl && user.llmModel) {
      return {
        baseUrl: user.llmBaseUrl,
        apiKey: user.llmApiKey ?? '',
        model: user.llmModel,
        enableThinking: user.llmEnableThinking,
      };
    }

    // 3. admin 未配个人 → 回退系统配置 llm.*
    if (user.role === UserRole.ADMIN) {
      if (llmConfig.enabled && llmConfig.baseUrl && llmConfig.model) {
        return {
          baseUrl: llmConfig.baseUrl,
          apiKey: llmConfig.apiKey,
          model: llmConfig.model,
          enableThinking: true,
        };
      }
    }

    // 4. 普通用户未配 → null
    return null;
  }

  // ============ 旧 llm_configs 表 CRUD（向后兼容保留） ============

  /** 列出全部 LLM 配置（admin） */
  findAll(): Promise<LlmConfig[]> {
    return this.configRepo.find({ order: { createdAt: 'ASC' } });
  }

  /** 单个（admin） */
  async findOne(id: string): Promise<LlmConfig> {
    const cfg = await this.configRepo.findOne({ where: { id } });
    if (!cfg) throw new NotFoundException(`LLM 配置 ${id} 不存在`);
    return cfg;
  }

  /** 创建（admin） */
  async create(
    data: {
      name: string;
      baseUrl: string;
      model: string;
      apiKey?: string;
      description?: string;
      enableThinking?: boolean;
      isEnabled?: boolean;
    },
    createdBy: string,
  ): Promise<LlmConfig> {
    if (!data.name?.trim()) throw new BadRequestException('名称不能为空');
    if (!data.baseUrl?.trim()) throw new BadRequestException('baseUrl 不能为空');
    if (!data.model?.trim()) throw new BadRequestException('model 不能为空');
    const row = this.configRepo.create({
      name: data.name.trim(),
      description: data.description ?? null,
      baseUrl: data.baseUrl.trim(),
      apiKey: data.apiKey?.trim() || null,
      model: data.model.trim(),
      enableThinking: data.enableThinking ?? true,
      isEnabled: data.isEnabled ?? true,
      createdBy,
    });
    return this.configRepo.save(row);
  }

  /** 更新（admin） */
  async update(
    id: string,
    data: Partial<Pick<LlmConfig, 'name' | 'baseUrl' | 'model' | 'apiKey' | 'description' | 'enableThinking' | 'isEnabled'>>,
  ): Promise<LlmConfig> {
    const cfg = await this.findOne(id);
    if (data.name !== undefined) cfg.name = data.name.trim();
    if (data.description !== undefined) cfg.description = data.description;
    if (data.baseUrl !== undefined) cfg.baseUrl = data.baseUrl.trim();
    if (data.model !== undefined) cfg.model = data.model.trim();
    if (data.apiKey !== undefined) cfg.apiKey = data.apiKey?.trim() || null;
    if (data.enableThinking !== undefined) cfg.enableThinking = data.enableThinking;
    if (data.isEnabled !== undefined) cfg.isEnabled = data.isEnabled;
    return this.configRepo.save(cfg);
  }

  /** 删除（admin）。若被用户引用，清除引用。 */
  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.userRepo.update({ llmConfigId: id }, { llmConfigId: null });
    await this.configRepo.delete(id);
  }

  /** 用户可选的配置列表（仅 isEnabled=true，apiKey 脱敏不返回） */
  async findEnabledForUser(): Promise<
    Pick<LlmConfig, 'id' | 'name' | 'description' | 'model' | 'enableThinking'>[]
  > {
    const rows = await this.configRepo.find({
      where: { isEnabled: true },
      order: { name: 'ASC' },
      select: ['id', 'name', 'description', 'model', 'enableThinking'],
    });
    return rows;
  }

  /** 获取当前用户选择的配置 id（旧逻辑） */
  async getUserSelection(userId: string): Promise<string | null> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'llmConfigId'],
    });
    return user?.llmConfigId ?? null;
  }

  /** 用户选择/取消选择配置（旧逻辑） */
  async setUserSelection(userId: string, configId: string | null): Promise<void> {
    if (configId) {
      const cfg = await this.configRepo.findOne({
        where: { id: configId, isEnabled: true },
      });
      if (!cfg) throw new BadRequestException('所选 LLM 配置不存在或已禁用');
    }
    await this.userRepo.update({ id: userId }, { llmConfigId: configId });
  }
}

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSetting } from './system-setting.entity';

/**
 * 可在线修改的设置项定义
 * key 唯一；env 为对应 .env 变量名（用于回退默认值）；type 决定反序列化
 * label/description 供前端展示；sensitive=true 时 GET 返回脱敏占位
 */
interface SettingDef {
  key: string;
  env: string;
  type: 'string' | 'number' | 'boolean';
  label: string;
  description: string;
  group: string;
  sensitive?: boolean;
}

/**
 * 可在线修改的配置项清单（白名单）
 * 不在此清单的配置项（如 jwtSecret、服务 URL、端口）不可改，只能编辑 .env 重启。
 */
export const SETTING_DEFS: readonly SettingDef[] = [
  // --- LLM ---
  {
    key: 'llm.enabled',
    env: 'LLM_ENABLED',
    type: 'boolean',
    label: '启用 LLM',
    description: '未启用时 AI 总结/知识库生成等功能不可用',
    group: 'LLM 大模型',
  },
  {
    key: 'llm.baseUrl',
    env: 'LLM_BASE_URL',
    type: 'string',
    label: 'LLM Base URL',
    description: 'OpenAI 兼容端点地址',
    group: 'LLM 大模型',
  },
  {
    key: 'llm.apiKey',
    env: 'LLM_API_KEY',
    type: 'string',
    label: 'LLM API Key',
    description: '调用密钥，内网若无需鉴权可留空',
    group: 'LLM 大模型',
    sensitive: true,
  },
  {
    key: 'llm.model',
    env: 'LLM_MODEL',
    type: 'string',
    label: 'LLM 模型',
    description: '默认对话模型名',
    group: 'LLM 大模型',
  },
  {
    key: 'llm.embedBaseUrl',
    env: 'LLM_EMBED_BASE_URL',
    type: 'string',
    label: 'Embedding 服务 URL',
    description: '向量模型推理端点（TEI），如 http://<tei-host>:8081',
    group: 'LLM 大模型',
  },
  {
    key: 'llm.embedModel',
    env: 'LLM_EMBED_MODEL',
    type: 'string',
    label: 'Embedding 模型',
    description: '向量模型标识，如 BAAI/bge-m3',
    group: 'LLM 大模型',
  },
  {
    key: 'llm.embedDimensions',
    env: 'LLM_EMBED_DIMENSIONS',
    type: 'number',
    label: '向量维度',
    description: 'bge-m3 = 1024，需与向量列维度一致',
    group: 'LLM 大模型',
  },
  {
    key: 'llm.timeout',
    env: 'LLM_TIMEOUT',
    type: 'number',
    label: 'LLM 超时(毫秒)',
    description: '单次请求超时',
    group: 'LLM 大模型',
  },
  {
    key: 'llm.maxRetries',
    env: 'LLM_MAX_RETRIES',
    type: 'number',
    label: 'LLM 重试次数',
    description: '网络错误/5xx 最多重试次数',
    group: 'LLM 大模型',
  },
  {
    key: 'llm.summaryMaxChars',
    env: 'LLM_SUMMARY_MAX_CHARS',
    type: 'number',
    label: '总结最大字符数',
    description: '单次投喂文本上限，超出则截断头尾',
    group: 'LLM 大模型',
  },
  // --- OnlyOffice ---
  {
    key: 'onlyoffice.enabled',
    env: 'ONLYOFFICE_ENABLED',
    type: 'boolean',
    label: '启用 OnlyOffice',
    description: '关闭后文档编辑功能不可用，预览仍可用 kkFileView',
    group: 'OnlyOffice 文档编辑',
  },
  // --- kkFileView ---
  {
    key: 'kkfileview.enabled',
    env: 'KKFILEVIEW_ENABLED',
    type: 'boolean',
    label: '启用 kkFileView',
    description: '关闭后文件预览回退到浏览器原生能力',
    group: 'kkFileView 文件预览',
  },
  // --- Docling ---
  {
    key: 'docling.enabled',
    env: 'DOCLING_ENABLED',
    type: 'boolean',
    label: '启用 Docling',
    description: 'PDF/Office 文本提取后端',
    group: 'Docling 文本提取',
  },
  {
    key: 'docling.doOcr',
    env: 'DOCLING_DO_OCR',
    type: 'boolean',
    label: '启用 OCR',
    description: '扫描版 PDF 文本识别（耗时较长）',
    group: 'Docling 文本提取',
  },
  // --- Auth ---
  {
    key: 'auth.allowSignup',
    env: 'ALLOW_SIGNUP',
    type: 'boolean',
    label: '允许注册',
    description: '关闭后新用户只能由 admin 创建',
    group: '认证与账户',
  },
  // --- Upload ---
  {
    key: 'upload.maxDocFileSizeMB',
    env: 'UPLOAD_MAX_DOC_MB',
    type: 'number',
    label: '文档最大体积(MB)',
    description: '上传文档单文件大小上限',
    group: '上传限制',
  },
  {
    key: 'upload.maxImageFileSizeMB',
    env: 'UPLOAD_MAX_IMAGE_MB',
    type: 'number',
    label: '图片最大体积(MB)',
    description: '上传图片单文件大小上限',
    group: '上传限制',
  },
];

/** 脱敏显示：敏感值返回 "******"，非空时表示已配置 */
function maskValue(value: string | null, sensitive: boolean): string | null {
  if (value === null || value === undefined) return null;
  if (sensitive && value !== '') return '******';
  return value;
}

@Injectable()
export class SystemSettingsService implements OnModuleInit {
  private readonly logger = new Logger(SystemSettingsService.name);

  constructor(
    @InjectRepository(SystemSetting)
    private readonly repo: Repository<SystemSetting>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reloadOverrides();
  }

  /** 从 DB 加载所有设置项到内存覆盖层 */
  async reloadOverrides(): Promise<void> {
    const { setOverride } = await import('./settings-overrides');
    const rows = await this.repo.find();
    let count = 0;
    for (const def of SETTING_DEFS) {
      const row = rows.find((r) => r.key === def.key);
      if (row && row.value !== null) {
        setOverride(def.key, row.value);
        count++;
      }
    }
    this.logger.log(`已加载 ${count} 项系统设置覆盖`);
  }

  /** 获取单项设置的运行时有效值（优先 DB 覆盖，回退 process.env） */
  getEffectiveValue(def: SettingDef): string {
    const { getOverrideString } = require('./settings-overrides') as typeof import('./settings-overrides');
    const override = getOverrideString(def.key, '');
    if (override !== '') return override;
    return process.env[def.env] ?? '';
  }

  /**
   * 获取全部设置（分可改/只读两组，敏感值脱敏）
   * 供 GET /system/config 返回前端
   */
  async getAllForDisplay() {
    const { getOverrideBool, getOverrideNumber, getOverrideString } =
      await import('./settings-overrides');
    const rows = await this.repo.find();
    const rowMap = new Map(rows.map((r) => [r.key, r]));

    const editable = SETTING_DEFS.map((def) => {
      const raw = this.getEffectiveValue(def);
      const isOverridden = rowMap.has(def.key);
      return {
        key: def.key,
        label: def.label,
        description: def.description,
        group: def.group,
        type: def.type,
        value: maskValue(raw, !!def.sensitive),
        // 是否已被 DB 覆盖（非 .env 默认）
        overridden: isOverridden,
      };
    });

    return { editable };
  }

  /** 批量更新设置项（仅白名单内、非脱敏占位值才写入） */
  async updateMany(
    items: { key: string; value: string | null }[],
    updatedBy: string,
  ): Promise<{ updated: string[]; skipped: string[] }> {
    const { setOverride } = await import('./settings-overrides');
    const defMap = new Map(SETTING_DEFS.map((d) => [d.key, d]));
    const updated: string[] = [];
    const skipped: string[] = [];

    for (const item of items) {
      const def = defMap.get(item.key);
      if (!def) {
        skipped.push(`${item.key}(未知项)`);
        continue;
      }
      // 敏感项：若前端传回脱敏占位 "******" 视为不修改
      if (def.sensitive && item.value === '******') {
        skipped.push(`${item.key}(脱敏占位，跳过)`);
        continue;
      }
      // 类型校验
      if (def.type === 'number') {
        const n = Number(item.value);
        if (!Number.isFinite(n) || n <= 0) {
          skipped.push(`${item.key}(非法数值)`);
          continue;
        }
      }
      if (def.type === 'boolean') {
        if (
          item.value !== null &&
          item.value !== 'true' &&
          item.value !== 'false' &&
          item.value !== ''
        ) {
          skipped.push(`${item.key}(非法布尔)`);
          continue;
        }
      }

      // 写 DB
      let row = await this.repo.findOne({ where: { key: item.key } });
      if (!row) {
        row = this.repo.create({
          key: item.key,
          valueType: def.type,
          description: def.label,
        });
      }
      row.value = item.value === '' ? null : item.value;
      row.valueType = def.type;
      row.description = def.label;
      row.updatedBy = updatedBy;
      await this.repo.save(row);

      // 刷新内存覆盖
      setOverride(item.key, row.value);
      updated.push(item.key);
    }

    this.logger.log(
      `admin ${updatedBy} 更新设置：${updated.length} 项，跳过 ${skipped.length} 项`,
    );
    return { updated, skipped };
  }
}

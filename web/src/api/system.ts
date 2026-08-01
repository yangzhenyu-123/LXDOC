import client from './client';

// 系统配置响应（后端 GET /system/config 返回，admin only）
export interface SystemConfig {
  llm: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    embedModel: string;
    embedDimensions: number;
    timeout: number;
    maxRetries: number;
    summaryMaxChars: number;
  };
  onlyoffice: {
    enabled: boolean;
    onlyofficeUrl: string;
    onlyofficePublicUrl: string;
    backendPublicUrl: string;
  };
  kkfileview: {
    enabled: boolean;
    internalUrl: string;
    publicUrl: string;
  };
  docling: {
    enabled: boolean;
    baseUrl: string;
    doOcr: boolean;
    timeout: number;
  };
  auth: {
    jwtAccessExpires: string;
    jwtRefreshExpires: string;
    fileTokenExpires: string;
    allowSignup: boolean;
  };
  upload: {
    uploadDir: string;
    maxDocFileSizeMB: number;
    maxImageFileSizeMB: number;
    allowedDocExtensions: string[];
    allowedImageExtensions: string[];
  };
}

/** 可在线修改的设置项（GET /system/settings 返回） */
export interface EditableSetting {
  key: string;
  label: string;
  description: string;
  group: string;
  type: 'string' | 'number' | 'boolean';
  value: string | null;
  overridden: boolean;
}

export interface EditableSettingsResponse {
  editable: EditableSetting[];
}

export interface UpdateConfigResult {
  updated: string[];
  skipped: string[];
}

/**
 * 获取系统配置（仅 admin）
 * GET /system/config
 */
export function getSystemConfig(): Promise<SystemConfig> {
  return client.get<SystemConfig, SystemConfig>('/system/config');
}

/**
 * 获取可在线修改的设置项清单（含分组/类型/脱敏值）
 * GET /system/settings
 */
export function getEditableSettings(): Promise<EditableSettingsResponse> {
  return client.get<EditableSettingsResponse, EditableSettingsResponse>(
    '/system/settings',
  );
}

/**
 * 批量更新可在线修改的设置项（仅 admin，立即生效）
 * PUT /system/config
 * items: 要修改的键值对。敏感项传 "******" 视为不修改。
 */
export function updateSystemConfig(
  items: { key: string; value: string | null }[],
): Promise<UpdateConfigResult> {
  return client.put<UpdateConfigResult, UpdateConfigResult>(
    '/system/config',
    { items },
  );
}

/**
 * 系统设置覆盖层（内存单例）
 *
 * 设计：config/*.config.ts 的 getter 在返回 process.env 默认值前，先查此 Map。
 * SystemSettingsService 启动时从 DB 加载到此 Map，更新时刷新。
 * 这样所有消费点（llmConfig.baseUrl 等）自动拿到 DB 值，无需改消费方代码。
 *
 * 键约定：点分命名，如 llm.enabled / auth.allowSignup / upload.maxDocFileSizeMB
 * 值统一存字符串，由各 config getter 按需转型。
 */

const overrides = new Map<string, string>();

/** 读取覆盖值，无则返回 null（调用方回退 process.env） */
export function getOverride(key: string): string | null {
  return overrides.get(key) ?? null;
}

/** 写入覆盖值（SystemSettingsService 加载/更新时调用） */
export function setOverride(key: string, value: string | null): void {
  if (value === null || value === undefined || value === '') {
    overrides.delete(key);
  } else {
    overrides.set(key, value);
  }
}

/** 清空所有覆盖（主要供测试使用） */
export function clearOverrides(): void {
  overrides.clear();
}

/** 读取并转 boolean，无覆盖返回 fallback */
export function getOverrideBool(key: string, fallback: boolean): boolean {
  const v = overrides.get(key);
  if (v === undefined || v === null || v === '') return fallback;
  return v.toLowerCase() === 'true';
}

/** 读取并转 number，无覆盖或非法返回 fallback */
export function getOverrideNumber(key: string, fallback: number): number {
  const v = overrides.get(key);
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 读取字符串覆盖，无覆盖返回 fallback */
export function getOverrideString(key: string, fallback: string): string {
  const v = overrides.get(key);
  if (v === undefined || v === null || v === '') return fallback;
  return v;
}

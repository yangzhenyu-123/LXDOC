import axios, { type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';

// 全局 axios 实例，baseURL=/api 由 vite proxy 转发到后端 3000 端口
const client = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// localStorage 持久化键（与 stores/auth.ts 保持一致）
const LS_ACCESS_TOKEN = 'lxdoc_access_token';
const LS_REFRESH_TOKEN = 'lxdoc_refresh_token';
const LS_USER = 'lxdoc_user';

// 请求拦截器：从 localStorage 注入 Authorization Bearer 令牌
client.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem(LS_ACCESS_TOKEN);
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// 标记已重试，避免无限重试
interface RetryableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

// 防并发 refresh：模块级 promise，多个 401 共享同一 refresh
// 后端 refresh 轮换，返回新的 access + 新的 refresh
let refreshing: Promise<{ accessToken: string; refreshToken: string }> | null =
  null;

// refresh 是否已失败：失败后不再尝试 refresh，直接拒绝并跳转登录
// 避免会话已失效时大量 401 请求反复触发 refresh 造成风暴
// 用户重新登录成功后由 store 调用 resetRefreshFailure 复位
let refreshFailed = false;

/**
 * 跳转登录页：用 window.location 避免 router 循环依赖
 */
function redirectToLogin(): void {
  const redirect = window.location.pathname + window.location.search;
  // 已在登录页则不再跳
  if (window.location.pathname.startsWith('/login')) return;
  window.location.href = '/login?redirect=' + encodeURIComponent(redirect);
}

/**
 * 清空本地鉴权态
 */
function clearLocalAuth(): void {
  localStorage.removeItem(LS_ACCESS_TOKEN);
  localStorage.removeItem(LS_REFRESH_TOKEN);
  localStorage.removeItem(LS_USER);
}

/**
 * 同步 pinia store 的 tokens（refresh 成功后调用）
 * 动态 import 规避 client ↔ store 循环依赖
 */
async function syncStoreTokens(
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  try {
    const { useAuthStore } = await import('@/stores/auth');
    useAuthStore().setTokens(accessToken, refreshToken);
  } catch (e) {
    // store 未就绪（应用启动早期），忽略；localStorage 已更新
    console.warn('[client] sync store tokens failed', e);
  }
}

/**
 * 通知 store 强制登出（refresh 失败时调用）
 */
async function syncStoreForceLogout(): Promise<void> {
  try {
    const { useAuthStore } = await import('@/stores/auth');
    useAuthStore().forceLogout();
  } catch {
    // ignore
  }
}

/**
 * 复位 refresh 失败标记（用户重新登录后由 store 调用）
 */
export function resetRefreshFailure(): void {
  refreshFailed = false;
}

// 响应拦截器：成功返回 response.data；401 触发 refresh 并重放原请求
client.interceptors.response.use(
  (response) => response.data,
  async (err) => {
    const original = err.config as RetryableConfig | undefined;
    const status = err?.response?.status;
    const url: string = original?.url ?? '';

    if (
      status === 401 &&
      original &&
      !original._retry &&
      !url.includes('/auth/refresh') &&
      !url.includes('/auth/login')
    ) {
      // refresh 已失败：会话已失效，直接拒绝（redirectToLogin 已触发）
      if (refreshFailed) {
        return Promise.reject(err);
      }
      original._retry = true;
      const refreshToken = localStorage.getItem(LS_REFRESH_TOKEN);
      if (!refreshToken) {
        refreshFailed = true;
        clearLocalAuth();
        redirectToLogin();
        return Promise.reject(err);
      }
      try {
        if (!refreshing) {
          refreshing = import('./auth')
            .then((m) => m.refreshApi(refreshToken))
            .then(async (res) => {
              const newAccess = res?.accessToken;
              const newRefresh = res?.refreshToken;
              if (!newAccess || !newRefresh) {
                throw new Error('refresh 响应缺少 token');
              }
              // 持久化轮换后的新 access + 新 refresh token
              localStorage.setItem(LS_ACCESS_TOKEN, newAccess);
              localStorage.setItem(LS_REFRESH_TOKEN, newRefresh);
              // 同步 pinia store（保证页面内响应式状态一致）
              await syncStoreTokens(newAccess, newRefresh);
              return { accessToken: newAccess, refreshToken: newRefresh };
            })
            .finally(() => {
              refreshing = null;
            });
        }
        const { accessToken: newAccess } = await refreshing;
        original.headers = original.headers ?? {};
        (original.headers as Record<string, string>).Authorization =
          `Bearer ${newAccess}`;
        return client(original as AxiosRequestConfig);
      } catch (e) {
        // refresh 失败：标记 + 清空本地态 + 跳登录
        refreshFailed = true;
        clearLocalAuth();
        void syncStoreForceLogout();
        redirectToLogin();
        return Promise.reject(e);
      }
    }
    // 其他错误：打印并 reject
    console.error('[API Error]', status, err?.message);
    return Promise.reject(err);
  },
);

export default client;

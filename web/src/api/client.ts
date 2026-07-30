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
let refreshing: Promise<string> | null = null;

/**
 * 跳转登录页：用 window.location 避免 router 循环依赖
 */
function redirectToLogin(): void {
  const redirect = window.location.pathname + window.location.search;
  // 已在登录页则不再跳
  if (window.location.pathname.startsWith('/login')) return;
  window.location.href = '/login?redirect=' + encodeURIComponent(redirect);
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
      original._retry = true;
      const refreshToken = localStorage.getItem(LS_REFRESH_TOKEN);
      if (!refreshToken) {
        redirectToLogin();
        return Promise.reject(err);
      }
      try {
        // 动态 import auth.ts，规避 client ↔ auth 循环依赖
        if (!refreshing) {
          refreshing = import('./auth')
            .then((m) => m.refreshApi(refreshToken))
            .then((res) => {
              const newAccess = (res as { accessToken: string }).accessToken;
              localStorage.setItem(LS_ACCESS_TOKEN, newAccess);
              return newAccess;
            })
            .finally(() => {
              refreshing = null;
            });
        }
        const newAccess = await refreshing;
        original.headers = original.headers ?? {};
        (original.headers as Record<string, string>).Authorization =
          `Bearer ${newAccess}`;
        return client(original as AxiosRequestConfig);
      } catch (e) {
        // refresh 失败：清空本地态并跳登录
        localStorage.removeItem(LS_ACCESS_TOKEN);
        localStorage.removeItem(LS_REFRESH_TOKEN);
        localStorage.removeItem(LS_USER);
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

import axios, { type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';

/**
 * 全局 axios 实例，baseURL=/api 由 vite proxy 转发到后端 3000 端口
 *
 * H8 修复：access/refresh token 改 httpOnly cookie 存储，
 * - withCredentials: true → 浏览器自动携带 + 接收 Set-Cookie
 * - 不再注入 Authorization 头（cookie 由后端读取）
 * - 不再读写 localStorage 中的 token（XSS 无法窃取）
 * 仅 user 信息仍存 localStorage（非敏感，用于刷新页面恢复 UI 状态）
 */
const client = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
});

// localStorage 仅持久化 user 信息（非敏感，UI 状态用）
const LS_USER = 'lxdoc_user';

// 标记已重试，避免无限重试
interface RetryableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

// 防并发 refresh：模块级 promise，多个 401 共享同一 refresh
// 后端 refresh 轮换，Set-Cookie 自动更新 httpOnly cookie
let refreshing: Promise<void> | null = null;

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
 * 清空本地 user 信息（token 已在 httpOnly cookie，由后端 logout 清除）
 */
function clearLocalAuth(): void {
  localStorage.removeItem(LS_USER);
}

/**
 * 通知 store 强制登出（refresh 失败时调用）
 * 动态 import 规避 client ↔ store 循环依赖
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
// H8：refresh 依赖 httpOnly cookie 自动携带，无需手动传 token；新 cookie 由后端 Set-Cookie 写入
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
      try {
        if (!refreshing) {
          refreshing = import('./auth')
            .then((m) => m.refreshApi())
            .then(() => {
              // cookie 已由后端 Set-Cookie 自动更新，无需前端处理
            })
            .finally(() => {
              refreshing = null;
            });
        }
        await refreshing;
        // 重放原请求：cookie 自动携带新 access token
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

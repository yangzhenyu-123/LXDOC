import { defineStore } from 'pinia';
import {
  loginApi,
  registerApi,
  logoutApi,
  refreshApi,
  type AuthUser,
  type RegisterDto,
} from '@/api/auth';
// 仅引入类型与重置函数，规避 client ↔ store 循环依赖（client 动态 import store）
import { resetRefreshFailure } from '@/api/client';

/**
 * H8 修复：access/refresh token 改 httpOnly cookie 存储，前端不再持有 token。
 * - state 仅保留 user（非敏感，用于 UI 状态与权限判断）
 * - isLoggedIn 基于 user 是否存在判断；若 cookie 已过期，首个 API 请求 401 →
 *   client 拦截器自动 refresh，refresh 失败则 forceLogout 清空 user
 * - user 持久化到 localStorage，刷新页面恢复 UI；token 由 cookie 管理，不持久化
 */
const LS_USER = 'lxdoc_user';

interface AuthState {
  user: AuthUser | null;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    user: null,
  }),

  getters: {
    // 是否已登录：基于本地 user 判断（cookie 真实状态由后端校验，过期时自动 refresh/登出）
    isLoggedIn: (state): boolean => !!state.user,
    // 是否为管理员
    isAdmin: (state): boolean => state.user?.role === 'admin',
    // 是否为编辑
    isEditor: (state): boolean => state.user?.role === 'editor',
    // 是否有写权限（admin 或 editor）
    canWrite: (state): boolean =>
      state.user?.role === 'admin' || state.user?.role === 'editor',
  },

  actions: {
    /**
     * 登录：调用后端 login 接口，token 经 httpOnly cookie 下发，仅保存 user
     */
    async login(email: string, password: string): Promise<AuthUser> {
      const res = await loginApi(email, password);
      this.user = res.user;
      this.persistUser();
      // 新登录重置 client 的 refresh 失败标记
      resetRefreshFailure();
      return res.user;
    },

    /**
     * 注册：调用后端 register 接口，成功后直接登录态
     */
    async register(dto: RegisterDto): Promise<AuthUser> {
      const res = await registerApi(dto);
      this.user = res.user;
      this.persistUser();
      resetRefreshFailure();
      return res.user;
    },

    /**
     * 更新当前用户
     */
    setUser(user: AuthUser): void {
      this.user = user;
      localStorage.setItem(LS_USER, JSON.stringify(user));
    },

    /**
     * 主动登出：调用后端 logout（清除 httpOnly cookie），再清空本地 user
     */
    async logout(): Promise<void> {
      try {
        await logoutApi();
      } catch (e) {
        // 即使后端登出失败也清空本地态
        console.warn('[auth] logout api failed, still clearing local state', e);
      } finally {
        this.clear();
      }
    },

    /**
     * 强制登出：不调用后端，仅清空本地 user（refresh 失败时使用）
     */
    forceLogout(): void {
      this.clear();
    },

    /**
     * 从 localStorage 恢复 user（应用启动时调用）
     * token 由 httpOnly cookie 管理，无需恢复；cookie 有效则后续请求自动携带，
     * 无效则首个 API 请求 401 → refresh → 失败则 forceLogout
     */
    restore(): void {
      const userJson = localStorage.getItem(LS_USER);
      if (userJson) {
        try {
          this.user = JSON.parse(userJson) as AuthUser;
        } catch {
          this.user = null;
        }
      } else {
        this.user = null;
      }
    },

    /**
     * 刷新令牌：后端轮换 Set-Cookie，前端无需处理 token；仅用于主动触发刷新场景
     * 失败时抛出，由调用方处理
     */
    async refresh(): Promise<void> {
      await refreshApi();
    },

    /**
     * 持久化 user 到 localStorage
     */
    persistUser(): void {
      if (this.user) {
        localStorage.setItem(LS_USER, JSON.stringify(this.user));
      }
    },

    /**
     * 清空 state + localStorage（仅 user，token 由后端 cookie 管理）
     */
    clear(): void {
      this.user = null;
      localStorage.removeItem(LS_USER);
    },
  },
});

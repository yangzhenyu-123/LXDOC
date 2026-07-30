import { defineStore } from 'pinia';
import {
  loginApi,
  registerApi,
  logoutApi,
  refreshApi,
  type AuthUser,
  type RegisterDto,
} from '@/api/auth';

// localStorage 持久化键
const LS_ACCESS_TOKEN = 'lxdoc_access_token';
const LS_REFRESH_TOKEN = 'lxdoc_refresh_token';
const LS_USER = 'lxdoc_user';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    accessToken: null,
    refreshToken: null,
    user: null,
  }),

  getters: {
    // 是否已登录
    isLoggedIn: (state): boolean => !!state.accessToken,
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
     * 登录：调用后端 login 接口，设置 state 并持久化
     */
    async login(email: string, password: string): Promise<AuthUser> {
      const res = await loginApi(email, password);
      this.accessToken = res.accessToken;
      this.refreshToken = res.refreshToken;
      this.user = res.user;
      this.persist();
      return res.user;
    },

    /**
     * 注册：调用后端 register 接口，成功后直接登录态
     */
    async register(dto: RegisterDto): Promise<AuthUser> {
      const res = await registerApi(dto);
      this.accessToken = res.accessToken;
      this.refreshToken = res.refreshToken;
      this.user = res.user;
      this.persist();
      return res.user;
    },

    /**
     * 仅更新 tokens（供 axios 拦截器调用）
     */
    setTokens(access: string, refresh?: string): void {
      this.accessToken = access;
      if (refresh) this.refreshToken = refresh;
      localStorage.setItem(LS_ACCESS_TOKEN, access);
      if (refresh) localStorage.setItem(LS_REFRESH_TOKEN, refresh);
    },

    /**
     * 更新当前用户
     */
    setUser(user: AuthUser): void {
      this.user = user;
      localStorage.setItem(LS_USER, JSON.stringify(user));
    },

    /**
     * 主动登出：调用后端 logout，再清空本地状态
     */
    async logout(): Promise<void> {
      try {
        if (this.refreshToken) {
          await logoutApi(this.refreshToken);
        }
      } catch (e) {
        // 即使后端登出失败也清空本地态
        console.warn('[auth] logout api failed, still clearing local state', e);
      } finally {
        this.clear();
      }
    },

    /**
     * 强制登出：不调用后端，仅清空本地（refresh 失败时使用）
     */
    forceLogout(): void {
      this.clear();
    },

    /**
     * 从 localStorage 恢复（应用启动时调用）
     */
    restore(): void {
      const access = localStorage.getItem(LS_ACCESS_TOKEN);
      const refresh = localStorage.getItem(LS_REFRESH_TOKEN);
      const userJson = localStorage.getItem(LS_USER);
      this.accessToken = access;
      this.refreshToken = refresh;
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
     * 刷新令牌：成功更新 accessToken；失败抛出
     */
    async refresh(): Promise<string> {
      if (!this.refreshToken) {
        throw new Error('no refresh token');
      }
      const res = await refreshApi(this.refreshToken);
      this.accessToken = res.accessToken;
      localStorage.setItem(LS_ACCESS_TOKEN, res.accessToken);
      return res.accessToken;
    },

    /**
     * 持久化到 localStorage
     */
    persist(): void {
      if (this.accessToken) {
        localStorage.setItem(LS_ACCESS_TOKEN, this.accessToken);
      }
      if (this.refreshToken) {
        localStorage.setItem(LS_REFRESH_TOKEN, this.refreshToken);
      }
      if (this.user) {
        localStorage.setItem(LS_USER, JSON.stringify(this.user));
      }
    },

    /**
     * 清空 state + localStorage
     */
    clear(): void {
      this.accessToken = null;
      this.refreshToken = null;
      this.user = null;
      localStorage.removeItem(LS_ACCESS_TOKEN);
      localStorage.removeItem(LS_REFRESH_TOKEN);
      localStorage.removeItem(LS_USER);
    },
  },
});

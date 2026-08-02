import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';

// 路由表：登录页 + 首页 + 分类详情 + 文档详情 + 全文检索 + 用户管理 + 审计
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
  },
  {
    path: '/c/:categoryId',
    name: 'category',
    component: () => import('@/views/CategoryView.vue'),
  },
  {
    path: '/d/:docId',
    name: 'document',
    component: () => import('@/views/DocumentView.vue'),
  },
  {
    // Docsify 风格阅读视图：专为 Markdown / AI 总结文档设计的纯阅读页
    // AI 总结生成后跳转至此，提供清爽的 docsify 风格渲染 + 查看原文入口
    path: '/read/:docId',
    name: 'read',
    component: () => import('@/views/DocsifyReaderView.vue'),
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('@/views/SearchView.vue'),
  },
  {
    // 快捷入口视图：最近/收藏/我的文档/我的组/标签
    // type: recent | favorites | my | my-org | tag
    // tag 类型时 query.t 指定标签名
    path: '/quick/:type',
    name: 'quick-access',
    component: () => import('@/views/QuickAccessView.vue'),
  },
  {
    // RAG 知识库列表 + admin 管理（CRUD + 文档加入/移出）
    path: '/kb',
    name: 'kb-list',
    component: () => import('@/views/KbListView.vue'),
  },
  {
    // RAG 知识库问答界面（核心：SSE 流式 + 引用 + 思考链）
    path: '/kb/:id',
    name: 'kb-ask',
    component: () => import('@/views/KbAskView.vue'),
  },
  {
    path: '/admin/users',
    name: 'admin-users',
    component: () => import('@/views/admin/UsersView.vue'),
    meta: { roles: ['admin'] },
  },
  {
    path: '/admin/organizations',
    name: 'admin-organizations',
    component: () => import('@/views/admin/OrganizationsView.vue'),
    meta: { roles: ['admin'] },
  },
  {
    path: '/admin/audit',
    name: 'admin-audit',
    component: () => import('@/views/admin/AuditView.vue'),
    meta: { roles: ['admin'] },
  },
  {
    // 系统配置：展示 LLM / OnlyOffice / kkFileView / docling 等各服务开关与状态
    path: '/admin/system',
    name: 'admin-system',
    component: () => import('@/views/admin/SystemConfigView.vue'),
    meta: { roles: ['admin'] },
  },
  {
    // LLM 配置管理（admin）：创建多套 LLM 配置供用户选择
    path: '/admin/llm-configs',
    name: 'admin-llm-configs',
    component: () => import('@/views/admin/LlmConfigView.vue'),
    meta: { roles: ['admin'] },
  },
  {
    // 个人设置（所有登录用户）：选择 LLM 配置等
    path: '/profile',
    name: 'profile',
    component: () => import('@/views/ProfileView.vue'),
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// 路由扩展声明：补充 meta 字段类型
declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean;
    roles?: string[];
  }
}

/**
 * 全局前置守卫：
 * - 公共路由直接放行
 * - 未登录跳 /login?redirect=...
 * - 已登录访问 /login 跳首页
 * - 已登录但角色不匹配跳首页
 *
 * H8 修复：token 改 httpOnly cookie，前端无法读取；以 localStorage 中的 user 信息
 * 作为登录态判据。user 存在但 cookie 过期时，首个 API 请求 401 → client 拦截器
 * 自动 refresh → 失败则 forceLogout 清空 user 并跳登录。
 */
router.beforeEach((to, _from, next) => {
  // 公共路由直接放行
  if (to.meta.public) {
    const hasUser = !!localStorage.getItem('lxdoc_user');
    // 已登录访问登录页 → 跳首页
    if (to.path === '/login' && hasUser) {
      next('/');
      return;
    }
    next();
    return;
  }

  // 检查登录态（基于 user 信息判据）
  const hasUser = !!localStorage.getItem('lxdoc_user');
  if (!hasUser) {
    next('/login?redirect=' + encodeURIComponent(to.fullPath));
    return;
  }

  // 检查角色
  const requiredRoles = to.meta.roles;
  if (requiredRoles && requiredRoles.length > 0) {
    let userRole: string | undefined;
    const userJson = localStorage.getItem('lxdoc_user');
    if (userJson) {
      try {
        userRole = (JSON.parse(userJson) as { role?: string }).role;
      } catch {
        userRole = undefined;
      }
    }
    if (!userRole || !requiredRoles.includes(userRole)) {
      next('/');
      return;
    }
  }

  next();
});

export default router;

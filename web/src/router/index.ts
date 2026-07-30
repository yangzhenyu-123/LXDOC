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
 */
router.beforeEach((to, _from, next) => {
  // 公共路由直接放行
  if (to.meta.public) {
    const access = localStorage.getItem('lxdoc_access_token');
    // 已登录访问登录页 → 跳首页
    if (to.path === '/login' && access) {
      next('/');
      return;
    }
    next();
    return;
  }

  // 检查登录态
  const access = localStorage.getItem('lxdoc_access_token');
  if (!access) {
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

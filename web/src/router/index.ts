import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';

// 路由表：首页 + 分类详情 + 文档详情 + 全文检索
const routes: RouteRecordRaw[] = [
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
    path: '/search',
    name: 'search',
    component: () => import('@/views/SearchView.vue'),
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;

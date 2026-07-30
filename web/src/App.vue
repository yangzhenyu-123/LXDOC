<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import CategoryTree from '@/components/CategoryTree.vue';

// LXDOC 根组件：顶部栏 + 左侧分类树（可折叠）+ 主区路由出口
const router = useRouter();

// 全局搜索框输入
const globalKeyword = ref('');

// 左侧分类树是否折叠
const asideCollapsed = ref(false);

/**
 * 提交全局搜索：跳转到 /search?q=...
 */
function submitSearch() {
  const q = globalKeyword.value.trim();
  if (!q) return;
  router.push({ path: '/search', query: { q } });
}

/**
 * 返回首页
 */
function goHome() {
  router.push('/');
}

/**
 * 切换左侧分类树折叠状态
 */
function toggleAside() {
  asideCollapsed.value = !asideCollapsed.value;
}

/**
 * 顶栏「上传文档」快捷按钮：跳到首页让用户从分类页触发上传
 */
function quickUpload() {
  router.push('/');
}

/**
 * CategoryTree 选中分类：跳转到分类详情页
 */
function onSelectCategory(categoryId: string) {
  router.push(`/c/${categoryId}`);
}
</script>

<template>
  <div class="app-layout">
    <!-- 顶部栏：Logo + 全局搜索框 + 上传快捷按钮 -->
    <header class="app-header">
      <div class="header-left">
        <el-button
          class="collapse-btn"
          text
          :title="asideCollapsed ? '展开分类树' : '折叠分类树'"
          @click="toggleAside"
        >
          <el-icon size="18">
            <Fold v-if="!asideCollapsed" />
            <Expand v-else />
          </el-icon>
        </el-button>
        <span class="logo" @click="goHome">LXDOC</span>
      </div>
      <div class="global-search">
        <el-input
          v-model="globalKeyword"
          placeholder="搜索文档..."
          clearable
          @keyup.enter="submitSearch"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
          <template #append>
            <el-button @click="submitSearch">搜索</el-button>
          </template>
        </el-input>
      </div>
      <div class="header-right">
        <el-button type="primary" @click="quickUpload">
          <el-icon class="el-icon--left"><Upload /></el-icon>
          上传文档
        </el-button>
      </div>
    </header>

    <!-- 主区：左侧分类树 + 右侧路由出口 -->
    <div class="app-body">
      <aside
        class="app-aside"
        :class="{ collapsed: asideCollapsed }"
      >
        <div class="aside-inner">
          <CategoryTree @select="onSelectCategory" />
        </div>
      </aside>
      <main class="app-main">
        <router-view />
      </main>
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0;
  padding: 0;
  height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue',
    Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
</style>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.app-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  height: 56px;
  background: #001529;
  color: #fff;
  flex-shrink: 0;
  border-bottom: 1px solid #001529;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.collapse-btn {
  color: #fff;
}
.collapse-btn:hover {
  color: #fff;
}
.logo {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #fff;
  cursor: pointer;
  user-select: none;
}
.global-search {
  flex: 1;
  max-width: 560px;
  margin: 0 auto;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.app-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}
.app-aside {
  width: 240px;
  flex-shrink: 0;
  background: #fff;
  border-right: 1px solid #e4e7ed;
  overflow: hidden;
  transition: width 0.2s ease;
}
.app-aside.collapsed {
  width: 0;
  border-right: none;
}
.aside-inner {
  width: 240px;
  height: 100%;
  overflow: auto;
  padding: 8px;
  box-sizing: border-box;
}
.app-main {
  flex: 1;
  overflow: auto;
  background: #f5f7fa;
}
</style>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ElMessage,
  ElMessageBox,
  type FormInstance,
  type FormRules,
} from 'element-plus';
import CategoryTree from '@/components/CategoryTree.vue';
import KnowledgeTree from '@/components/KnowledgeTree.vue';
import { useAuthStore } from '@/stores/auth';
import { changePasswordApi } from '@/api/auth';
import { getKnowledgeTree } from '@/api/knowledge';
import { listKbs, type KnowledgeBase } from '@/api/kb';
// 前端版本号（来自 web/package.json，构建时注入）
import { version as appVersion } from '@/../package.json';

// LXDOC 根组件：三栏布局
//  - 顶栏：Logo + 全局搜索 + 上传 + 用户菜单
//  - 左侧导航栏：顶部三分区切换图标（文档库/知识库/配置）+ 下方对应导航内容
//  - 主区：路由出口
const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

// 全局搜索框输入
const globalKeyword = ref('');

// RAG 知识库列表（知识库分区入口，点击进入问答）
const ragKbs = ref<KnowledgeBase[]>([]);
const ragKbsLoading = ref(false);

// 当前激活的左侧导航分区：docs(文档库) / knowledge(AI知识库) / settings(配置管理)
type NavZone = 'docs' | 'knowledge' | 'settings';
const activeZone = ref<NavZone>('docs');

// 左侧导航栏整体是否折叠（仅折叠内容区，分区图标始终可见）
const navCollapsed = ref(false);

/**
 * 提交全局搜索：跳转到 /search?q=...
 */
function submitSearch() {
  const q = globalKeyword.value.trim();
  if (!q) return;
  router.push({ path: '/search', query: { q } });
  // 搜索时切到文档库分区，避免在配置分区下搜索无左侧树回退
  activeZone.value = 'docs';
}

/**
 * 返回首页
 */
function goHome() {
  router.push('/');
  activeZone.value = 'docs';
}

/**
 * 切换左侧导航栏折叠状态
 */
function toggleNav() {
  navCollapsed.value = !navCollapsed.value;
}

/**
 * 切换左侧导航分区
 */
function switchZone(zone: NavZone) {
  activeZone.value = zone;
  // 切到配置分区时按需跳转对应管理页
  if (zone === 'settings') {
    // 默认进入系统配置页（若已在某个 admin 页则保持）
    const adminPaths = ['/admin/users', '/admin/organizations', '/admin/audit', '/admin/system', '/admin/llm-configs'];
    if (!adminPaths.some((p) => route.path.startsWith(p))) {
      router.push('/admin/system');
    }
  } else if (zone === 'knowledge') {
    // 知识库分区：保持在首页或当前文档页均可，不强制跳转
  }
}

/**
 * 顶栏「上传文档」快捷按钮：跳到首页让用户从分类页触发上传
 */
function quickUpload() {
  router.push('/');
  activeZone.value = 'docs';
}

/**
 * CategoryTree 选中分类：跳转到分类详情页
 */
function onSelectCategory(categoryId: string) {
  router.push(`/c/${categoryId}`);
}

/**
 * 快捷入口跳转
 */
function goQuick(type: 'recent' | 'favorites' | 'my' | 'my-org') {
  router.push(`/quick/${type}`);
}

// 当前快捷入口高亮（基于路由）
const activeQuick = computed(() => {
  if (route.path === '/quick/recent') return 'recent';
  if (route.path === '/quick/favorites') return 'favorites';
  if (route.path === '/quick/my') return 'my';
  if (route.path === '/quick/my-org') return 'my-org';
  return '';
});

/**
 * KnowledgeTree 选中节点：跳转到对应文档或分类
 */
function onSelectKnowledge(payload: { type: 'doc' | 'dir'; id?: string; path?: string }) {
  if (payload.type === 'doc' && payload.id) {
    router.push(`/read/${payload.id}`);
  }
}

// ============== 用户菜单与修改密码 ==============

// 修改密码对话框
const pwdDialogVisible = ref(false);
const pwdFormRef = ref<FormInstance>();
const pwdForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
});
const pwdLoading = ref(false);

// 修改密码表单校验规则
const pwdRules: FormRules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        if (value !== pwdForm.newPassword) {
          callback(new Error('两次输入的新密码不一致'));
        } else {
          callback();
        }
      },
      trigger: 'blur',
    },
  ],
};

// 用户头像首字母
const avatarText = computed(() => {
  const name = authStore.user?.username || authStore.user?.email || '?';
  return name.charAt(0).toUpperCase();
});

// 是否在公共路由（如登录页）：不显示主布局
const isPublicRoute = computed(() => !!route.meta.public);

// 配置管理子菜单高亮：根据当前路由判断
const activeSettingsMenu = computed(() => {
  if (route.path.startsWith('/admin/users')) return 'users';
  if (route.path.startsWith('/admin/organizations')) return 'organizations';
  if (route.path.startsWith('/admin/audit')) return 'audit';
  if (route.path.startsWith('/admin/system')) return 'system';
  if (route.path.startsWith('/admin/llm-configs')) return 'llm';
  return '';
});

// 当前路由是否在文档库相关页面（首页/分类/文档详情/搜索）
const isDocsRoute = computed(() => {
  return (
    route.path === '/' ||
    route.path.startsWith('/c/') ||
    route.path.startsWith('/d/') ||
    route.path.startsWith('/read/') ||
    route.path.startsWith('/search')
  );
});

// 根据当前路由自动切换分区（首次加载/路由变化时）
watch(
  () => route.path,
  (p) => {
    if (p.startsWith('/admin')) {
      activeZone.value = 'settings';
    } else if (p === '/' || p.startsWith('/c/') || p.startsWith('/d/') || p.startsWith('/search')) {
      // /read/ 也可能在知识库分区点击后进入，保持当前分区
      activeZone.value = 'docs';
    }
  },
  { immediate: true },
);

/**
 * 打开修改密码对话框
 */
function openChangePassword() {
  pwdForm.oldPassword = '';
  pwdForm.newPassword = '';
  pwdForm.confirmPassword = '';
  pwdDialogVisible.value = true;
}

/**
 * 提交修改密码
 */
async function submitChangePassword() {
  if (!pwdFormRef.value) return;
  await pwdFormRef.value.validate(async (valid) => {
    if (!valid) return;
    pwdLoading.value = true;
    try {
      await changePasswordApi(pwdForm.oldPassword, pwdForm.newPassword);
      ElMessage.success('密码修改成功，请重新登录');
      pwdDialogVisible.value = false;
      await authStore.logout();
      router.push('/login');
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || '修改密码失败';
      ElMessage.error(typeof msg === 'string' ? msg : '修改密码失败');
    } finally {
      pwdLoading.value = false;
    }
  });
}

/**
 * 退出登录
 */
async function handleLogout() {
  try {
    await ElMessageBox.confirm('确认退出登录？', '提示', {
      type: 'warning',
    });
  } catch {
    return;
  }
  await authStore.logout();
  ElMessage.success('已退出登录');
  router.push('/login');
}

/**
 * 下拉菜单 command 分发
 */
function handleCommand(cmd: string) {
  switch (cmd) {
    case 'password':
      openChangePassword();
      break;
    case 'profile':
      router.push('/profile');
      break;
    case 'logout':
      handleLogout();
      break;
  }
}

/**
 * 配置管理子菜单跳转
 */
function goSettings(menu: 'users' | 'organizations' | 'audit' | 'system' | 'llm') {
  switch (menu) {
    case 'users':
      router.push('/admin/users');
      break;
    case 'organizations':
      router.push('/admin/organizations');
      break;
    case 'audit':
      router.push('/admin/audit');
      break;
    case 'system':
      router.push('/admin/system');
      break;
    case 'llm':
      router.push('/admin/llm-configs');
      break;
  }
}

/**
 * 加载 RAG 知识库列表（知识库分区入口）
 */
async function loadRagKbs() {
  ragKbsLoading.value = true;
  try {
    ragKbs.value = await listKbs();
  } catch (err: any) {
    // 静默失败：列表加载失败不阻塞页面，用户切换分区可见空列表
    console.warn('[kb] 加载知识库列表失败', err);
    ragKbs.value = [];
  } finally {
    ragKbsLoading.value = false;
  }
}

/**
 * 跳转到 RAG 知识库问答页
 */
function goKbAsk(id: string) {
  router.push(`/kb/${id}`);
}

/**
 * 跳转到 RAG 知识库管理页（admin）
 */
function goKbManage() {
  router.push('/kb');
}

// 应用启动时从 localStorage 恢复登录态
onMounted(() => {
  authStore.restore();
  // 预加载 RAG 知识库列表（知识库分区入口）
  void loadRagKbs();
});
</script>

<template>
  <!-- 公共路由（如登录页）：仅渲染路由出口，不显示主布局 -->
  <router-view v-if="isPublicRoute" />

  <!-- 主布局：顶栏 + 左侧导航栏（分区切换 + 导航内容）+ 主区路由出口 -->
  <div v-else class="app-layout">
    <!-- 顶部栏：Logo + 全局搜索框 + 上传快捷按钮 + 用户菜单 -->
    <header class="app-header">
      <div class="header-left">
        <span class="logo" @click="goHome">LXDOC</span>
        <span class="logo-sub">企业知识库</span>
        <span class="logo-version">v{{ appVersion }}</span>
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
        <!-- 上传文档按钮：仅 editor/admin 可见 -->
        <el-button
          v-permission="['editor', 'admin']"
          type="primary"
          @click="quickUpload"
        >
          <el-icon class="el-icon--left"><Upload /></el-icon>
          上传文档
        </el-button>

        <!-- 用户下拉菜单 -->
        <el-dropdown trigger="click" @command="handleCommand">
          <span class="user-trigger">
            <el-avatar :size="30" class="user-avatar">{{ avatarText }}</el-avatar>
            <span class="user-name">{{ authStore.user?.username || authStore.user?.email || '用户' }}</span>
            <el-icon><ArrowDown /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="profile">个人设置</el-dropdown-item>
              <el-dropdown-item command="password">修改密码</el-dropdown-item>
              <el-dropdown-item divided command="logout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>

    <!-- 主区：左侧导航栏 + 右侧路由出口 -->
    <div class="app-body">
      <nav class="nav-bar" :class="{ collapsed: navCollapsed }">
        <!-- 分区切换图标列 -->
        <div class="zone-rail">
          <button
            class="zone-btn"
            :class="{ active: activeZone === 'docs' }"
            title="文档库"
            @click="switchZone('docs')"
          >
            <el-icon size="20"><Files /></el-icon>
            <span class="zone-label">文档库</span>
          </button>
          <button
            class="zone-btn"
            :class="{ active: activeZone === 'knowledge' }"
            title="AI 知识库"
            @click="switchZone('knowledge')"
          >
            <el-icon size="20"><MagicStick /></el-icon>
            <span class="zone-label">知识库</span>
          </button>
          <button
            v-if="authStore.isAdmin"
            class="zone-btn"
            :class="{ active: activeZone === 'settings' }"
            title="配置管理"
            @click="switchZone('settings')"
          >
            <el-icon size="20"><Setting /></el-icon>
            <span class="zone-label">配置</span>
          </button>
          <!-- 底部折叠按钮 -->
          <button class="zone-btn collapse-btn" title="折叠/展开" @click="toggleNav">
            <el-icon size="18">
              <Fold v-if="!navCollapsed" />
              <Expand v-else />
            </el-icon>
          </button>
        </div>

        <!-- 分区导航内容 -->
        <div class="zone-panel" v-show="!navCollapsed">
          <!-- 文档库：快捷入口 + 分类树 -->
          <div v-show="activeZone === 'docs'" class="panel-section">
            <div class="panel-header">
              <span class="panel-title">分类目录</span>
            </div>
            <div class="panel-body">
              <!-- 快捷入口 -->
              <ul class="quick-menu">
                <li :class="{ active: activeQuick === 'recent' }" @click="goQuick('recent')">
                  <el-icon><Clock /></el-icon>
                  <span>最近更新</span>
                </li>
                <li :class="{ active: activeQuick === 'favorites' }" @click="goQuick('favorites')">
                  <el-icon><StarFilled /></el-icon>
                  <span>我的收藏</span>
                </li>
                <li :class="{ active: activeQuick === 'my' }" @click="goQuick('my')">
                  <el-icon><User /></el-icon>
                  <span>我的文档</span>
                </li>
                <li :class="{ active: activeQuick === 'my-org' }" @click="goQuick('my-org')">
                  <el-icon><OfficeBuilding /></el-icon>
                  <span>我的组文档</span>
                </li>
              </ul>
              <div class="quick-divider"></div>
              <!-- 分类树 -->
              <CategoryTree @select="onSelectCategory" />
            </div>
          </div>

          <!-- AI 知识库：RAG 知识库入口 + AI 总结文档树 -->
          <div v-show="activeZone === 'knowledge'" class="panel-section">
            <div class="panel-header">
              <span class="panel-title">AI 知识库</span>
              <el-button
                v-if="authStore.isAdmin"
                text
                size="small"
                class="panel-action"
                @click="goKbManage"
              >
                管理
              </el-button>
            </div>
            <div class="panel-body">
              <!-- RAG 知识库入口（点击进入问答） -->
              <div class="kb-section">
                <div class="kb-section-title">
                  <el-icon><ChatDotRound /></el-icon>
                  <span>智能问答</span>
                </div>
                <ul class="kb-menu" v-loading="ragKbsLoading">
                  <li
                    v-for="kb in ragKbs"
                    :key="kb.id"
                    :class="{ active: route.path === `/kb/${kb.id}` }"
                    :title="kb.description || kb.name"
                    @click="goKbAsk(kb.id)"
                  >
                    <el-icon><ChatLineRound /></el-icon>
                    <span class="kb-name">{{ kb.name }}</span>
                    <el-tag v-if="kb.documentCount > 0" size="small" class="kb-count">
                      {{ kb.documentCount }}
                    </el-tag>
                  </li>
                  <el-empty
                    v-if="!ragKbsLoading && ragKbs.length === 0"
                    :image-size="50"
                    description="暂无知识库"
                  />
                </ul>
              </div>
              <div class="quick-divider"></div>
              <!-- AI 总结文档树 -->
              <KnowledgeTree @select="onSelectKnowledge" />
            </div>
          </div>

          <!-- 配置管理：菜单列表 -->
          <div v-show="activeZone === 'settings' && authStore.isAdmin" class="panel-section">
            <div class="panel-header">
              <span class="panel-title">配置管理</span>
            </div>
            <div class="panel-body">
              <ul class="settings-menu">
                <li
                  :class="{ active: activeSettingsMenu === 'system' }"
                  @click="goSettings('system')"
                >
                  <el-icon><Tools /></el-icon>
                  <span>系统配置</span>
                </li>
                <li
                  :class="{ active: activeSettingsMenu === 'llm' }"
                  @click="goSettings('llm')"
                >
                  <el-icon><MagicStick /></el-icon>
                  <span>用户LLM配置</span>
                </li>
                <li
                  :class="{ active: activeSettingsMenu === 'users' }"
                  @click="goSettings('users')"
                >
                  <el-icon><User /></el-icon>
                  <span>用户管理</span>
                </li>
                <li
                  :class="{ active: activeSettingsMenu === 'organizations' }"
                  @click="goSettings('organizations')"
                >
                  <el-icon><OfficeBuilding /></el-icon>
                  <span>组织管理</span>
                </li>
                <li
                  :class="{ active: activeSettingsMenu === 'audit' }"
                  @click="goSettings('audit')"
                >
                  <el-icon><Document /></el-icon>
                  <span>审计日志</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </nav>

      <main class="app-main">
        <router-view />
      </main>
    </div>

    <!-- 修改密码对话框 -->
    <el-dialog
      v-model="pwdDialogVisible"
      title="修改密码"
      width="420px"
      :close-on-click-modal="false"
    >
      <el-form
        ref="pwdFormRef"
        :model="pwdForm"
        :rules="pwdRules"
        label-position="top"
      >
        <el-form-item label="原密码" prop="oldPassword">
          <el-input
            v-model="pwdForm.oldPassword"
            type="password"
            show-password
            clearable
          />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="pwdForm.newPassword"
            type="password"
            show-password
            clearable
          />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input
            v-model="pwdForm.confirmPassword"
            type="password"
            show-password
            clearable
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="pwdLoading"
          @click="submitChangePassword"
        >
          确认修改
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}
/* ============ 顶栏 ============ */
.app-header {
  display: flex;
  align-items: center;
  gap: var(--lx-space-4);
  padding: 0 var(--lx-space-5);
  height: 56px;
  background: var(--lx-gradient-header);
  color: var(--lx-header-text);
  flex-shrink: 0;
  box-shadow: var(--lx-shadow-header);
  z-index: var(--lx-z-header);
}
.header-left {
  display: flex;
  align-items: baseline;
  gap: var(--lx-space-2);
  flex-shrink: 0;
}
.logo {
  font-size: var(--lx-font-2xl);
  font-weight: var(--lx-font-bold);
  letter-spacing: 1.5px;
  cursor: pointer;
  user-select: none;
  background: linear-gradient(90deg, var(--lx-primary-400), var(--lx-accent-400));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.logo-sub {
  font-size: var(--lx-font-xs);
  color: var(--lx-header-text-muted);
  letter-spacing: 0.5px;
}
.logo-version {
  font-size: var(--lx-font-xs);
  color: var(--lx-header-text-muted);
  opacity: 0.7;
  letter-spacing: 0.5px;
}
.global-search {
  flex: 1;
  max-width: 560px;
  margin: 0 auto;
}
.header-right {
  display: flex;
  align-items: center;
  gap: var(--lx-space-3);
  flex-shrink: 0;
}
.user-trigger {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  cursor: pointer;
  color: var(--lx-header-text);
  outline: none;
  padding: var(--lx-space-1) var(--lx-space-2);
  border-radius: var(--lx-radius-sm);
  transition: background var(--lx-transition-fast);
}
.user-trigger:hover {
  background: var(--lx-header-hover);
}
.user-avatar {
  background: var(--lx-gradient-primary);
  color: var(--lx-text-inverse);
  font-size: var(--lx-font-sm);
  font-weight: var(--lx-font-semibold);
}
.user-name {
  font-size: var(--lx-font-base);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ============ 主区 ============ */
.app-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* ============ 左侧导航栏 ============ */
.nav-bar {
  display: flex;
  width: 256px;
  flex-shrink: 0;
  background: var(--lx-bg-elevated);
  border-right: 1px solid var(--lx-border);
  transition: width var(--lx-transition);
  overflow: hidden;
}
.nav-bar.collapsed {
  width: 64px;
}

/* 分区切换图标列 */
.zone-rail {
  width: 64px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--lx-space-3) 0 var(--lx-space-2);
  gap: var(--lx-space-1);
  background: var(--lx-bg-subtle);
  border-right: 1px solid var(--lx-border);
}
.zone-btn {
  width: 52px;
  height: 52px;
  border: none;
  background: transparent;
  border-radius: var(--lx-radius-md);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  color: var(--lx-text-secondary);
  transition: all var(--lx-transition-fast);
  position: relative;
}
.zone-btn:hover {
  background: var(--lx-primary-50);
  color: var(--lx-primary);
}
.zone-btn.active {
  background: var(--lx-gradient-primary);
  color: var(--lx-text-inverse);
  box-shadow: var(--lx-shadow-primary);
}
.zone-label {
  font-size: var(--lx-font-xs);
  line-height: 1;
}
.collapse-btn {
  margin-top: auto;
  height: 44px;
  width: 52px;
}

/* 分区导航内容面板 */
.zone-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.panel-section {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.panel-header {
  height: 48px;
  display: flex;
  align-items: center;
  padding: 0 var(--lx-space-4);
  border-bottom: 1px solid var(--lx-border-light);
  flex-shrink: 0;
}
.panel-action {
  margin-left: auto;
  padding: 4px 8px !important;
  font-size: var(--lx-font-xs);
}
.panel-title {
  font-size: var(--lx-font-sm);
  font-weight: var(--lx-font-semibold);
  color: var(--lx-text-regular);
  letter-spacing: 0.5px;
}
.panel-body {
  flex: 1;
  overflow: auto;
  padding: var(--lx-space-2);
  box-sizing: border-box;
}

/* 快捷入口菜单 */
.quick-menu {
  list-style: none;
  margin: 0 0 var(--lx-space-2);
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.quick-menu li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--lx-radius-md);
  cursor: pointer;
  color: var(--lx-text-regular);
  font-size: var(--lx-font-sm);
  transition: all var(--lx-transition-fast);
}
.quick-menu li:hover {
  background: var(--lx-primary-50);
  color: var(--lx-primary);
}
.quick-menu li.active {
  background: linear-gradient(90deg, var(--lx-primary-100), var(--lx-primary-50));
  color: var(--lx-primary-700);
  font-weight: var(--lx-font-semibold);
}
.quick-divider {
  height: 1px;
  background: var(--lx-border-light);
  margin: var(--lx-space-2) 0;
}

/* 配置管理菜单 */
.settings-menu {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.settings-menu li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--lx-radius-md);
  cursor: pointer;
  color: var(--lx-text-regular);
  font-size: var(--lx-font-base);
  transition: all var(--lx-transition-fast);
}
.settings-menu li:hover {
  background: var(--lx-primary-50);
  color: var(--lx-primary);
}
.settings-menu li.active {
  background: linear-gradient(90deg, var(--lx-primary-100), var(--lx-primary-50));
  color: var(--lx-primary-700);
  font-weight: var(--lx-font-semibold);
}

/* RAG 知识库入口菜单 */
.kb-section {
  margin-bottom: var(--lx-space-1);
}
.kb-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px var(--lx-space-2);
  font-size: var(--lx-font-xs);
  color: var(--lx-text-secondary);
  font-weight: var(--lx-font-semibold);
  letter-spacing: 0.5px;
}
.kb-menu {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kb-menu li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--lx-radius-md);
  cursor: pointer;
  color: var(--lx-text-regular);
  font-size: var(--lx-font-sm);
  transition: all var(--lx-transition-fast);
}
.kb-menu li:hover {
  background: var(--lx-primary-50);
  color: var(--lx-primary);
}
.kb-menu li.active {
  background: linear-gradient(90deg, var(--lx-primary-100), var(--lx-primary-50));
  color: var(--lx-primary-700);
  font-weight: var(--lx-font-semibold);
}
.kb-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-count {
  flex-shrink: 0;
}

/* ============ 主路由区 ============ */
.app-main {
  flex: 1;
  overflow: auto;
  background: var(--lx-bg);
}
</style>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ElMessage,
  ElMessageBox,
  type FormInstance,
  type FormRules,
} from 'element-plus';
import CategoryTree from '@/components/CategoryTree.vue';
import { useAuthStore } from '@/stores/auth';
import { changePasswordApi } from '@/api/auth';

// LXDOC 根组件：顶部栏（Logo + 搜索 + 上传 + 用户菜单）+ 左侧分类树 + 主区路由出口
const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

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
 * 跳转用户管理页
 */
function goUsers() {
  router.push('/admin/users');
}

/**
 * 跳转组织管理页
 */
function goOrganizations() {
  router.push('/admin/organizations');
}

/**
 * 跳转审计日志页
 */
function goAudit() {
  router.push('/admin/audit');
}

/**
 * 下拉菜单 command 分发
 */
function handleCommand(cmd: string) {
  switch (cmd) {
    case 'password':
      openChangePassword();
      break;
    case 'logout':
      handleLogout();
      break;
    case 'users':
      goUsers();
      break;
    case 'organizations':
      goOrganizations();
      break;
    case 'audit':
      goAudit();
      break;
  }
}

// 应用启动时从 localStorage 恢复登录态
onMounted(() => {
  authStore.restore();
});
</script>

<template>
  <!-- 公共路由（如登录页）：仅渲染路由出口，不显示主布局 -->
  <router-view v-if="isPublicRoute" />

  <!-- 主布局：顶部栏 + 左侧分类树 + 主区路由出口 -->
  <div v-else class="app-layout">
    <!-- 顶部栏：Logo + 全局搜索框 + 上传快捷按钮 + 用户菜单 -->
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
            <el-avatar :size="28" class="user-avatar">{{ avatarText }}</el-avatar>
            <span class="user-name">{{ authStore.user?.username || authStore.user?.email || '用户' }}</span>
            <el-icon><ArrowDown /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="password">修改密码</el-dropdown-item>
              <el-dropdown-item divided command="logout">退出登录</el-dropdown-item>
              <template v-if="authStore.isAdmin">
                <el-dropdown-item divided command="users">用户管理</el-dropdown-item>
                <el-dropdown-item command="organizations">组织管理</el-dropdown-item>
                <el-dropdown-item command="audit">审计日志</el-dropdown-item>
              </template>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
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
  gap: 12px;
  flex-shrink: 0;
}
.user-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: #fff;
  outline: none;
}
.user-avatar {
  background: #1890ff;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
}
.user-name {
  font-size: 14px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

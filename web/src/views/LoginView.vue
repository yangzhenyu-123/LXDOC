<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { useAuthStore } from '@/stores/auth';

// 登录页：邮箱 + 密码 + 登录按钮；登录成功后按 redirect query 跳转
const route = useRoute();
const authStore = useAuthStore();

// 登录表单
// 注意：不预填默认账号密码，避免凭据泄露（生产环境尤其重要）
const loginFormRef = ref<FormInstance>();
const loginForm = reactive({
  email: '',
  password: '',
});
const loginLoading = ref(false);

// 登录表单校验规则
const loginRules: FormRules = {
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '邮箱格式不正确', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
};

// 注册弹窗状态
const registerVisible = ref(false);
const registerFormRef = ref<FormInstance>();
const registerForm = reactive({
  email: '',
  username: '',
  password: '',
});
const registerLoading = ref(false);

// 注册表单校验规则
const registerRules: FormRules = {
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '邮箱格式不正确', trigger: 'blur' },
  ],
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
};

/**
 * 提交登录
 */
async function submitLogin() {
  if (!loginFormRef.value) return;
  await loginFormRef.value.validate(async (valid) => {
    if (!valid) return;
    loginLoading.value = true;
    try {
      await authStore.login(loginForm.email, loginForm.password);
      ElMessage.success('登录成功');
      // 用硬跳转替代 router.push：登录页与主布局在 App.vue 中通过 v-if 切换，
      // SPA 路由跳转时主布局首次挂载的组件初始化时序不可靠，可能出现主界面不渲染。
      // 硬跳转强制 App.vue 重新挂载、restore() 重新执行、主布局组件完整初始化。
      const redirect = route.query.redirect;
      const target =
        typeof redirect === 'string' && redirect ? redirect : '/';
      window.location.href = target;
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || '登录失败';
      ElMessage.error(typeof msg === 'string' ? msg : '登录失败');
    } finally {
      loginLoading.value = false;
    }
  });
}

/**
 * 打开注册弹窗
 */
function openRegister() {
  registerForm.email = '';
  registerForm.username = '';
  registerForm.password = '';
  registerVisible.value = true;
}

/**
 * 提交注册
 */
async function submitRegister() {
  if (!registerFormRef.value) return;
  await registerFormRef.value.validate(async (valid) => {
    if (!valid) return;
      registerLoading.value = true;
    try {
      await authStore.register({
        email: registerForm.email,
        username: registerForm.username,
        password: registerForm.password,
      });
      ElMessage.success('注册成功，已自动登录');
      registerVisible.value = false;
      // 与登录一致：硬跳转确保主布局完整初始化（见 submitLogin 注释）
      const redirect = route.query.redirect;
      const target =
        typeof redirect === 'string' && redirect ? redirect : '/';
      window.location.href = target;
    } catch (e: any) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.message || e?.message || '注册失败';
      if (status === 403) {
        ElMessage.error('注册功能未开放');
      } else {
        ElMessage.error(typeof msg === 'string' ? msg : '注册失败');
      }
    } finally {
      registerLoading.value = false;
    }
  });
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <!-- 品牌标识 -->
      <div class="login-brand">
        <div class="brand-logo">LX</div>
        <h1 class="brand-name">LXDOC</h1>
        <p class="brand-sub">企业知识库</p>
      </div>
      <el-form
        ref="loginFormRef"
        :model="loginForm"
        :rules="loginRules"
        label-position="top"
        @keyup.enter="submitLogin"
      >
        <el-form-item label="邮箱" prop="email">
          <el-input
            v-model="loginForm.email"
            placeholder="请输入邮箱"
            clearable
          />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="loginForm.password"
            type="password"
            placeholder="请输入密码"
            show-password
            clearable
          />
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            :loading="loginLoading"
            style="width: 100%"
            @click="submitLogin"
          >
            登录
          </el-button>
        </el-form-item>
        <div class="login-extra">
          <el-button link type="primary" @click="openRegister">
            没有账号？注册
          </el-button>
        </div>
      </el-form>
    </div>

    <!-- 注册弹窗 -->
    <el-dialog
      v-model="registerVisible"
      title="注册新账号"
      width="420px"
      :close-on-click-modal="false"
    >
      <el-form
        ref="registerFormRef"
        :model="registerForm"
        :rules="registerRules"
        label-position="top"
      >
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="registerForm.email" placeholder="请输入邮箱" clearable />
        </el-form-item>
        <el-form-item label="用户名" prop="username">
          <el-input
            v-model="registerForm.username"
            placeholder="请输入用户名"
            clearable
          />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="registerForm.password"
            type="password"
            placeholder="至少 6 位"
            show-password
            clearable
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="registerVisible = false">取消</el-button>
        <el-button type="primary" :loading="registerLoading" @click="submitRegister">
          注册
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--lx-gradient-hero);
  position: relative;
  overflow: hidden;
}
/* 背景装饰光晕 */
.login-page::before,
.login-page::after {
  content: '';
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.3;
  pointer-events: none;
}
.login-page::before {
  width: 400px;
  height: 400px;
  background: var(--lx-primary);
  top: -100px;
  left: -100px;
}
.login-page::after {
  width: 360px;
  height: 360px;
  background: var(--lx-accent);
  bottom: -80px;
  right: -80px;
}

.login-card {
  width: 400px;
  padding: var(--lx-space-8) var(--lx-space-6) var(--lx-space-6);
  background: var(--lx-bg-elevated);
  border-radius: var(--lx-radius-lg);
  box-shadow: var(--lx-shadow-lg);
  position: relative;
  z-index: 1;
}

/* 品牌标识 */
.login-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: var(--lx-space-8);
}
.brand-logo {
  width: 56px;
  height: 56px;
  border-radius: var(--lx-radius-lg);
  background: var(--lx-gradient-primary);
  color: var(--lx-text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--lx-font-xl);
  font-weight: var(--lx-font-bold);
  letter-spacing: 1px;
  margin-bottom: var(--lx-space-3);
  box-shadow: var(--lx-shadow-primary);
}
.brand-name {
  margin: 0;
  font-size: var(--lx-font-2xl);
  font-weight: var(--lx-font-bold);
  letter-spacing: 2px;
  background: linear-gradient(90deg, var(--lx-primary), var(--lx-accent));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.brand-sub {
  margin: var(--lx-space-1) 0 0;
  font-size: var(--lx-font-sm);
  color: var(--lx-text-secondary);
  letter-spacing: 1px;
}

.login-extra {
  display: flex;
  justify-content: center;
  margin-top: calc(-1 * var(--lx-space-2));
}
</style>

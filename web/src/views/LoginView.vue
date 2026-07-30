<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { useAuthStore } from '@/stores/auth';

// 登录页：邮箱 + 密码 + 登录按钮；登录成功后按 redirect query 跳转
const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

// 登录表单
const loginFormRef = ref<FormInstance>();
const loginForm = reactive({
  email: 'admin@lxdoc.local',
  password: 'lxdoc12345',
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
      const redirect = route.query.redirect;
      if (typeof redirect === 'string' && redirect) {
        router.push(redirect);
      } else {
        router.push('/');
      }
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
      const redirect = route.query.redirect;
      if (typeof redirect === 'string' && redirect) {
        router.push(redirect);
      } else {
        router.push('/');
      }
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
      <div class="login-title">LXDOC 企业知识库 - 登录</div>
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
      <div class="login-hint">
        默认管理员：admin@lxdoc.local / lxdoc12345（仅用于首次登录提示）
      </div>
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
  background: linear-gradient(135deg, #1f2a44 0%, #001529 100%);
}
.login-card {
  width: 380px;
  padding: 32px 28px 24px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}
.login-title {
  font-size: 20px;
  font-weight: 600;
  color: #1f2a44;
  text-align: center;
  margin-bottom: 24px;
}
.login-extra {
  display: flex;
  justify-content: center;
  margin-top: -8px;
}
.login-hint {
  margin-top: 12px;
  font-size: 12px;
  color: #909399;
  text-align: center;
  line-height: 1.6;
}
</style>

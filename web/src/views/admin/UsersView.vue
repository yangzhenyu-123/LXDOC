<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  listUsersApi,
  createUserApi,
  updateUserApi,
  deleteUserApi,
  type UserItem,
} from '@/api/users';
import { useAuthStore } from '@/stores/auth';

// 用户管理页：管理员可创建用户、改角色、启用/禁用、删除
const authStore = useAuthStore();

// 列表数据
const users = ref<UserItem[]>([]);
const total = ref(0);
const loading = ref(false);
const page = ref(1);
const pageSize = ref(20);

// 新建用户对话框
const createVisible = ref(false);
const createFormRef = ref<FormInstance>();
const createForm = reactive({
  email: '',
  username: '',
  password: '',
  role: 'viewer',
});
const createLoading = ref(false);

// 新建用户校验规则
const createRules: FormRules = {
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '邮箱格式不正确', trigger: 'blur' },
  ],
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
  role: [{ required: true, message: '请选择角色', trigger: 'change' }],
};

// 角色 → el-tag 类型
function roleTagType(role: string): 'danger' | 'primary' | 'info' {
  if (role === 'admin') return 'danger';
  if (role === 'editor') return 'primary';
  return 'info';
}

// 状态 → el-tag 类型
function statusTagType(status: string): 'success' | 'info' {
  return status === 'active' ? 'success' : 'info';
}

// 格式化时间
function formatTime(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/**
 * 加载用户列表
 */
async function loadUsers() {
  loading.value = true;
  try {
    const res = await listUsersApi(page.value, pageSize.value);
    users.value = res.items ?? [];
    total.value = res.total ?? 0;
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '加载用户列表失败';
    ElMessage.error(typeof msg === 'string' ? msg : '加载用户列表失败');
  } finally {
    loading.value = false;
  }
}

/**
 * 修改角色
 */
async function onRoleChange(row: UserItem, newRole: string) {
  try {
    await updateUserApi(row.id, { role: newRole });
    ElMessage.success('角色已更新');
    await loadUsers();
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '更新角色失败';
    ElMessage.error(typeof msg === 'string' ? msg : '更新角色失败');
    await loadUsers();
  }
}

/**
 * 启用/禁用切换
 */
async function onStatusChange(row: UserItem, newStatus: string) {
  try {
    await updateUserApi(row.id, { status: newStatus });
    ElMessage.success(newStatus === 'active' ? '已启用' : '已禁用');
    await loadUsers();
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '更新状态失败';
    ElMessage.error(typeof msg === 'string' ? msg : '更新状态失败');
    await loadUsers();
  }
}

/**
 * 删除用户（不能删自己）
 */
async function onDelete(row: UserItem) {
  if (row.id === authStore.user?.id) {
    ElMessage.warning('不能删除当前登录用户');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认删除用户 ${row.username}（${row.email}）？`,
      '删除确认',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await deleteUserApi(row.id);
    ElMessage.success('用户已删除');
    await loadUsers();
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '删除用户失败';
    ElMessage.error(typeof msg === 'string' ? msg : '删除用户失败');
  }
}

/**
 * 打开新建用户对话框
 */
function openCreate() {
  createForm.email = '';
  createForm.username = '';
  createForm.password = '';
  createForm.role = 'viewer';
  createVisible.value = true;
}

/**
 * 提交新建用户
 */
async function submitCreate() {
  if (!createFormRef.value) return;
  await createFormRef.value.validate(async (valid) => {
    if (!valid) return;
    createLoading.value = true;
    try {
      await createUserApi({
        email: createForm.email,
        username: createForm.username,
        password: createForm.password,
        role: createForm.role,
      });
      ElMessage.success('用户创建成功');
      createVisible.value = false;
      await loadUsers();
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || '创建用户失败';
      ElMessage.error(typeof msg === 'string' ? msg : '创建用户失败');
    } finally {
      createLoading.value = false;
    }
  });
}

/**
 * 分页变更
 */
function onPageChange(p: number) {
  page.value = p;
  loadUsers();
}

onMounted(loadUsers);
</script>

<template>
  <div class="users-view">
    <div class="page-toolbar">
      <h2 class="page-title">用户管理</h2>
      <el-button type="primary" @click="openCreate">
        <el-icon class="el-icon--left"><Plus /></el-icon>
        新建用户
      </el-button>
    </div>

    <el-table
      v-loading="loading"
      :data="users"
      border
      stripe
      style="width: 100%"
    >
      <el-table-column prop="email" label="邮箱" min-width="200" />
      <el-table-column prop="username" label="用户名" min-width="140" />
      <el-table-column label="角色" width="160">
        <template #default="{ row }">
          <el-select
            :model-value="row.role"
            size="small"
            style="width: 110px"
            @change="(v: string) => onRoleChange(row, v)"
          >
            <el-option label="管理员" value="admin" />
            <el-option label="编辑" value="editor" />
            <el-option label="查看" value="viewer" />
          </el-select>
          <el-tag :type="roleTagType(row.role)" size="small" style="margin-left: 6px">
            {{ row.role }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="120">
        <template #default="{ row }">
          <el-switch
            :model-value="row.status === 'active'"
            active-text="启用"
            inactive-text="禁用"
            inline-prompt
            @change="(v: boolean) => onStatusChange(row, v ? 'active' : 'disabled')"
          />
          <el-tag :type="statusTagType(row.status)" size="small" style="margin-left: 6px">
            {{ row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }">
          <el-button
            type="danger"
            size="small"
            :disabled="row.id === authStore.user?.id"
            @click="onDelete(row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="pagination-wrap">
      <el-pagination
        background
        layout="total, prev, pager, next, jumper"
        :current-page="page"
        :page-size="pageSize"
        :total="total"
        @current-change="onPageChange"
      />
    </div>

    <!-- 新建用户对话框 -->
    <el-dialog
      v-model="createVisible"
      title="新建用户"
      width="460px"
      :close-on-click-modal="false"
    >
      <el-form
        ref="createFormRef"
        :model="createForm"
        :rules="createRules"
        label-position="top"
      >
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="createForm.email" placeholder="请输入邮箱" clearable />
        </el-form-item>
        <el-form-item label="用户名" prop="username">
          <el-input v-model="createForm.username" placeholder="请输入用户名" clearable />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="createForm.password"
            type="password"
            placeholder="至少 6 位"
            show-password
            clearable
          />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="createForm.role" style="width: 100%">
            <el-option label="管理员（admin）" value="admin" />
            <el-option label="编辑（editor）" value="editor" />
            <el-option label="查看（viewer）" value="viewer" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="createLoading" @click="submitCreate">
          创建
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.users-view {
  padding: 16px;
}
.page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.page-title {
  margin: 0;
  font-size: 18px;
  color: #1f2a44;
}
.pagination-wrap {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>

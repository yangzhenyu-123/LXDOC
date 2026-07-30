<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  listAuditApi,
  AUDIT_ACTIONS,
  type AuditItem,
} from '@/api/audit';

// 审计日志页：按 action、时间范围筛选；点击详情查看 JSON
const loading = ref(false);
const items = ref<AuditItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);

// 筛选条件
const filter = reactive<{
  action: string;
  dateRange: [string, string] | null;
}>({
  action: '',
  dateRange: null,
});

// 详情对话框
const detailVisible = ref(false);
const detailText = ref('');

// 格式化时间
function formatTime(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// action → el-tag 类型
function actionTagType(action: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  if (action === 'login') return 'success';
  if (action === 'logout') return 'info';
  if (action.endsWith('_delete')) return 'danger';
  if (action.endsWith('_create')) return 'primary';
  if (action.endsWith('_update') || action === 'permission_change') return 'warning';
  return 'info';
}

// UserAgent 截断显示
function truncateUA(ua: string | null, len = 40): string {
  if (!ua) return '-';
  return ua.length > len ? ua.slice(0, len) + '…' : ua;
}

/**
 * 构造查询参数
 */
function buildQuery() {
  const q: {
    action?: string;
    startDate?: string;
    endDate?: string;
    page: number;
    pageSize: number;
  } = {
    page: page.value,
    pageSize: pageSize.value,
  };
  if (filter.action) q.action = filter.action;
  if (filter.dateRange && filter.dateRange.length === 2) {
    q.startDate = filter.dateRange[0];
    q.endDate = filter.dateRange[1];
  }
  return q;
}

/**
 * 查询审计日志
 */
async function loadAudit() {
  loading.value = true;
  try {
    const res = await listAuditApi(buildQuery());
    items.value = res.items ?? [];
    total.value = res.total ?? 0;
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '加载审计日志失败';
    ElMessage.error(typeof msg === 'string' ? msg : '加载审计日志失败');
  } finally {
    loading.value = false;
  }
}

/**
 * 点击查询
 */
function onSearch() {
  page.value = 1;
  loadAudit();
}

/**
 * 重置筛选
 */
function onReset() {
  filter.action = '';
  filter.dateRange = null;
  page.value = 1;
  loadAudit();
}

/**
 * 查看详情 JSON
 */
function showDetail(row: AuditItem) {
  try {
    detailText.value = JSON.stringify(row.detail, null, 2);
  } catch {
    detailText.value = String(row.detail);
  }
  detailVisible.value = true;
}

/**
 * 分页变更
 */
function onPageChange(p: number) {
  page.value = p;
  loadAudit();
}

onMounted(loadAudit);
</script>

<template>
  <div class="audit-view">
    <div class="page-toolbar">
      <h2 class="page-title">审计日志</h2>
    </div>

    <!-- 筛选区 -->
    <div class="filter-bar">
      <el-select
        v-model="filter.action"
        placeholder="动作类型"
        clearable
        style="width: 200px"
      >
        <el-option
          v-for="a in AUDIT_ACTIONS"
          :key="a"
          :label="a"
          :value="a"
        />
      </el-select>
      <el-date-picker
        v-model="filter.dateRange"
        type="daterange"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        value-format="YYYY-MM-DD"
        style="width: 280px"
      />
      <el-button type="primary" @click="onSearch">
        <el-icon class="el-icon--left"><Search /></el-icon>
        查询
      </el-button>
      <el-button @click="onReset">重置</el-button>
    </div>

    <el-table
      v-loading="loading"
      :data="items"
      border
      stripe
      style="width: 100%"
    >
      <el-table-column label="时间" width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="用户ID" width="180">
        <template #default="{ row }">{{ row.userId || '-' }}</template>
      </el-table-column>
      <el-table-column label="动作" width="170">
        <template #default="{ row }">
          <el-tag :type="actionTagType(row.action)" size="small">{{ row.action }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="目标" min-width="180">
        <template #default="{ row }">
          <span v-if="row.targetType || row.targetId">
            {{ row.targetType || '-' }} / {{ row.targetId || '-' }}
          </span>
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="IP" width="140">
        <template #default="{ row }">{{ row.ip || '-' }}</template>
      </el-table-column>
      <el-table-column label="UserAgent" min-width="200">
        <template #default="{ row }">{{ truncateUA(row.userAgent) }}</template>
      </el-table-column>
      <el-table-column label="详情" width="100" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="showDetail(row)">
            查看
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

    <!-- 详情对话框 -->
    <el-dialog
      v-model="detailVisible"
      title="审计详情"
      width="640px"
      :close-on-click-modal="true"
    >
      <pre class="detail-json">{{ detailText }}</pre>
    </el-dialog>
  </div>
</template>

<style scoped>
.audit-view {
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
.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.pagination-wrap {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
.detail-json {
  background: #f5f7fa;
  padding: 12px;
  border-radius: 4px;
  font-size: 12px;
  max-height: 400px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
</style>

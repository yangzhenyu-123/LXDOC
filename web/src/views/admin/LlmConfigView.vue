<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  listUsersLlmOverview,
  type UserLlmOverview,
} from '@/api/llm-config';

/**
 * 用户 LLM 配置管理页（admin）
 *
 * 新架构：每个用户在自己的个人设置配自己的 LLM。
 * 此页只读展示所有用户的 LLM 配置情况（apiKey 脱敏），
 * 方便 admin 了解哪些用户已配、哪些未配（无法使用 AI）。
 *
 * admin 自己的配置在「个人设置」页填写，可覆盖系统配置。
 */
const overview = ref<UserLlmOverview[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    overview.value = await listUsersLlmOverview();
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// 统计
function stats() {
  const total = overview.value.length;
  const configured = overview.value.filter(
    (u) => !!u.llmBaseUrl && !!u.llmModel,
  ).length;
  return { total, configured, unconfigured: total - configured };
}

function roleLabel(role: string): string {
  return role === 'admin' ? '管理员' : role === 'editor' ? '编辑者' : '只读';
}

function roleTagType(role: string): '' | 'success' | 'warning' | 'info' {
  return role === 'admin' ? 'warning' : role === 'editor' ? 'success' : 'info';
}
</script>

<template>
  <div class="llm-config-view" v-loading="loading">
    <header class="page-header">
      <div>
        <h1>LLM 配置管理</h1>
        <p class="subtitle">
          查看所有用户的 LLM 配置情况。每个用户在「个人设置」配置自己的模型端点与 API。
          普通用户未配置时无法使用 AI 功能。
        </p>
      </div>
    </header>

    <!-- 统计卡片 -->
    <section class="stats-row">
      <div class="stat-card">
        <div class="stat-num">{{ stats().total }}</div>
        <div class="stat-label">总用户数</div>
      </div>
      <div class="stat-card success">
        <div class="stat-num">{{ stats().configured }}</div>
        <div class="stat-label">已配置 LLM</div>
      </div>
      <div class="stat-card warning">
        <div class="stat-num">{{ stats().unconfigured }}</div>
        <div class="stat-label">未配置（无法使用 AI）</div>
      </div>
    </section>

    <!-- 用户配置表格 -->
    <section class="card">
      <h2 class="card-title">
        <el-icon><User /></el-icon> 用户 LLM 配置概览
      </h2>
      <el-table :data="overview" stripe class="overview-table">
        <el-table-column label="用户" min-width="180">
          <template #default="{ row }">
            <div class="user-cell">
              <el-avatar :size="28" class="user-avatar">
                {{ (row.username || row.email || '?').charAt(0).toUpperCase() }}
              </el-avatar>
              <div class="user-info">
                <div class="user-name">{{ row.username }}</div>
                <div class="user-email">{{ row.email }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="100">
          <template #default="{ row }">
            <el-tag :type="roleTagType(row.role)" size="small">{{ roleLabel(row.role) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Base URL" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.llmBaseUrl" class="mono">{{ row.llmBaseUrl }}</span>
            <span v-else class="muted">未配置</span>
          </template>
        </el-table-column>
        <el-table-column label="模型" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.llmModel" class="mono">{{ row.llmModel }}</span>
            <span v-else class="muted">未配置</span>
          </template>
        </el-table-column>
        <el-table-column label="API Key" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.llmApiKeyConfigured ? 'success' : 'info'" size="small" effect="plain">
              {{ row.llmApiKeyConfigured ? '已配置' : '未配置' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="推理模式" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.llmEnableThinking ? 'success' : 'info'" size="small" effect="plain">
              {{ row.llmEnableThinking ? '开启' : '关闭' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="代理身份" width="110" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.llmActAsUserId" type="warning" size="small">已设置</el-tag>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag
              :type="row.llmBaseUrl && row.llmModel ? 'success' : 'warning'"
              size="small"
            >
              {{ row.llmBaseUrl && row.llmModel ? '可用' : '未配置' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="overview.length === 0 && !loading" class="empty-tip">
        暂无用户数据
      </div>
    </section>

    <!-- 说明 -->
    <section class="card info-card">
      <h2 class="card-title">
        <el-icon><InfoFilled /></el-icon> 说明
      </h2>
      <ul class="info-list">
        <li>每个用户在「个人设置」配置自己的 LLM（Base URL / API Key / 模型名）。</li>
        <li>普通用户必须自行配置才能使用 AI 总结与知识库生成（系统不提供默认 API）。</li>
        <li>管理员未配个人 LLM 时回退「系统配置」中的 LLM 默认值。</li>
        <li>管理员可在「个人设置」设置代理身份，以其他用户的身份调用 AI（方便测试）。</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.llm-config-view {
  padding: var(--lx-space-6);
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
}
.page-header {
  margin-bottom: var(--lx-space-5);
}
.page-header h1 {
  margin: 0 0 var(--lx-space-1);
  font-size: var(--lx-font-2xl);
  font-weight: var(--lx-font-bold);
  color: var(--lx-text);
}
.subtitle {
  margin: 0;
  font-size: var(--lx-font-sm);
  color: var(--lx-text-secondary);
}

/* 统计卡片 */
.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--lx-space-4);
  margin-bottom: var(--lx-space-5);
}
.stat-card {
  background: var(--lx-bg-elevated);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-lg);
  padding: var(--lx-space-5);
  box-shadow: var(--lx-shadow-sm);
}
.stat-card.success {
  border-color: var(--lx-success);
  background: linear-gradient(135deg, var(--lx-bg-elevated), var(--lx-success-bg));
}
.stat-card.warning {
  border-color: var(--lx-warning);
  background: linear-gradient(135deg, var(--lx-bg-elevated), var(--lx-warning-bg));
}
.stat-num {
  font-size: var(--lx-font-3xl);
  font-weight: var(--lx-font-bold);
  color: var(--lx-text);
}
.stat-label {
  font-size: var(--lx-font-sm);
  color: var(--lx-text-secondary);
  margin-top: var(--lx-space-1);
}

/* 卡片 */
.card {
  background: var(--lx-bg-elevated);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-lg);
  padding: var(--lx-space-5) var(--lx-space-6);
  box-shadow: var(--lx-shadow-sm);
  margin-bottom: var(--lx-space-5);
}
.card-title {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  font-size: var(--lx-font-lg);
  font-weight: var(--lx-font-semibold);
  color: var(--lx-text);
  margin: 0 0 var(--lx-space-4);
}

/* 表格用户单元格 */
.user-cell {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
}
.user-avatar {
  background: var(--lx-gradient-primary);
  color: var(--lx-text-inverse);
  font-size: var(--lx-font-xs);
  font-weight: var(--lx-font-semibold);
  flex-shrink: 0;
}
.user-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.user-name {
  font-weight: var(--lx-font-semibold);
  color: var(--lx-text);
  font-size: var(--lx-font-base);
}
.user-email {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
}

.mono {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: var(--lx-font-xs);
}
.muted {
  color: var(--lx-text-placeholder);
  font-size: var(--lx-font-sm);
}

.empty-tip {
  padding: var(--lx-space-8);
  text-align: center;
  color: var(--lx-text-placeholder);
  font-size: var(--lx-font-sm);
}

/* 说明卡片 */
.info-card {
  background: var(--lx-primary-50);
  border-color: var(--lx-primary-100);
}
.info-list {
  margin: 0;
  padding-left: var(--lx-space-5);
  color: var(--lx-text-regular);
  font-size: var(--lx-font-sm);
  line-height: 1.8;
}
.info-list li {
  margin-bottom: var(--lx-space-1);
}
</style>

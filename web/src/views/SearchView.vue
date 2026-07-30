<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { search as searchApi, type SearchResult } from '@/api/search';
import { sanitizeHtml } from '@/utils/sanitize';

const route = useRoute();
const router = useRouter();

// 搜索框输入
const keyword = ref('');
// 实际发起检索的关键词
const activeQuery = ref('');
// 结果列表
const results = ref<SearchResult[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);

// 状态
const loading = ref(false);
const loadError = ref<string | null>(null);
// 是否已发起过检索（用于区分初始空状态 vs 无结果）
const hasSearched = ref(false);

// 是否空结果
const isEmpty = computed(
  () => hasSearched.value && !loading.value && results.value.length === 0,
);

/**
 * 发起检索
 */
async function doSearch() {
  const q = keyword.value.trim();
  if (!q) return;
  activeQuery.value = q;
  page.value = 1;
  await fetchResults();
}

/**
 * 拉取当前页结果
 */
async function fetchResults() {
  if (!activeQuery.value) return;
  loading.value = true;
  loadError.value = null;
  try {
    const res = await searchApi(
      activeQuery.value,
      page.value,
      pageSize.value,
    );
    results.value = res?.items ?? [];
    total.value = res?.total ?? 0;
    hasSearched.value = true;
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '检索失败';
    loadError.value = msg;
    results.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

/**
 * 分页变化
 */
function onPageChange(p: number) {
  page.value = p;
  fetchResults();
}

/**
 * 跳转到文档详情
 */
function goDoc(id: string) {
  router.push(`/d/${id}`);
}

/**
 * 时间格式化
 */
function formatTime(s: string | Date): string {
  if (!s) return '';
  const d = typeof s === 'string' ? new Date(s) : s;
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 同步 URL query.q 到本地状态并触发检索
 */
function syncFromRoute() {
  const q = route.query.q;
  if (typeof q === 'string' && q.trim()) {
    keyword.value = q.trim();
    doSearch();
  } else {
    keyword.value = '';
    activeQuery.value = '';
    results.value = [];
    total.value = 0;
    hasSearched.value = false;
  }
}

// 路由 query 变化时重新检索
watch(
  () => route.query.q,
  () => {
    syncFromRoute();
  },
);

onMounted(() => {
  syncFromRoute();
});
</script>

<template>
  <div class="search-view">
    <!-- 顶部搜索栏 -->
    <div class="search-bar">
      <el-input
        v-model="keyword"
        placeholder="输入关键词搜索文档，回车提交"
        clearable
        class="search-input"
        @keyup.enter="doSearch"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-button type="primary" :loading="loading" @click="doSearch">
        搜索
      </el-button>
    </div>

    <!-- 检索元信息 -->
    <div v-if="hasSearched && !loadError" class="meta">
      共找到 <strong>{{ total }}</strong> 条结果（第 {{ page }} 页）
    </div>

    <!-- 错误提示 -->
    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      class="error-alert"
    />

    <!-- 结果列表 -->
    <div class="results" v-loading="loading">
      <el-empty
        v-if="isEmpty"
        description="未找到相关文档"
      />
      <div
        v-for="item in results"
        :key="item.id"
        class="result-card"
        @click="goDoc(item.id)"
      >
        <div class="card-header">
          <span class="card-title">{{ item.title }}</span>
          <div class="card-tags">
            <el-tag size="small" type="info">{{ item.format }}</el-tag>
            <el-tag v-if="item.categoryName" size="small">
              {{ item.categoryName }}
            </el-tag>
          </div>
        </div>
        <!-- 高亮片段：后端已包 <mark>，前端 sanitize 后 v-html（防 snippet 含恶意 HTML） -->
        <p
          v-if="item.snippet"
          class="card-snippet"
          v-html="sanitizeHtml(item.snippet)"
        />
        <div class="card-footer">
          <span>最后修改：{{ formatTime(item.updatedAt) }}</span>
          <span>v{{ item.version }}</span>
        </div>
      </div>
    </div>

    <!-- 分页 -->
    <div v-if="total > pageSize" class="pagination">
      <el-pagination
        :current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next, total"
        background
        @current-change="onPageChange"
      />
    </div>
  </div>
</template>

<style scoped>
.search-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f5f7fa;
  padding: 16px;
  gap: 12px;
}
.search-bar {
  display: flex;
  gap: 8px;
  background: #fff;
  padding: 12px;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
}
.search-input {
  flex: 1;
}
.meta {
  font-size: 13px;
  color: #606266;
  padding: 0 4px;
}
.error-alert {
  margin-bottom: 0;
}
.results {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.result-card {
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  padding: 14px 16px;
  cursor: pointer;
  transition: box-shadow 0.2s, border-color 0.2s;
}
.result-card:hover {
  border-color: #409eff;
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.15);
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.card-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}
.card-tags {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.card-snippet {
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
  margin: 0 0 8px;
  max-height: 4.8em;
  overflow: hidden;
}
.card-snippet :deep(mark) {
  background: #fff3cd;
  color: #856404;
  padding: 0 2px;
  border-radius: 2px;
}
.card-footer {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #909399;
}
.pagination {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}
</style>

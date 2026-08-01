<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  getRecentDocuments,
  getFavorites,
  getMyDocuments,
  getMyOrgDocuments,
  getTags,
  type DocumentListItem,
} from '@/api/documents';
import { useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();

// 快捷类型
type QuickType = 'recent' | 'favorites' | 'my' | 'my-org' | 'tag';
const quickType = computed<QuickType>(() => {
  const t = String(route.params.type ?? '');
  return ['recent', 'favorites', 'my', 'my-org', 'tag'].includes(t)
    ? (t as QuickType)
    : 'recent';
});

// 标签名（仅 type=tag 时使用，从 query.t 取）
const tagName = computed(() => String(route.query.t ?? ''));

// 页面标题与图标映射
const meta = computed(() => {
  switch (quickType.value) {
    case 'recent':
      return { title: '最近更新', icon: 'Clock', desc: '最近更新的文档' };
    case 'favorites':
      return { title: '我的收藏', icon: 'StarFilled', desc: '我收藏的文档' };
    case 'my':
      return { title: '我的文档', icon: 'User', desc: '我创建的文档' };
    case 'my-org':
      return { title: '我的组文档', icon: 'OfficeBuilding', desc: '我所在组织的文档' };
    case 'tag':
      return { title: `标签：${tagName.value}`, icon: 'PriceTag', desc: '该标签下的所有文档' };
    default:
      return { title: '文档列表', icon: 'Files', desc: '' };
  }
});

const documents = ref<DocumentListItem[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

// 格式 tag 配色
function getFormatTagType(
  fmt: string,
): '' | 'success' | 'info' | 'warning' | 'danger' {
  switch (fmt) {
    case 'md':
    case 'docx':
      return '';
    case 'txt':
      return 'info';
    case 'odt':
      return 'success';
    case 'pdf':
      return 'danger';
    default:
      return '';
  }
}

function formatTime(s: string | Date): string {
  if (!s) return '';
  const d = typeof s === 'string' ? new Date(s) : s;
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function goDoc(id: string) {
  router.push(`/d/${id}`);
}

function goBack() {
  router.back();
}

// 标签云数据（仅 type=tag 时加载）
const tags = ref<{ tag: string; count: number }[]>([]);
const tagsLoading = ref(false);

async function loadTags() {
  tagsLoading.value = true;
  try {
    tags.value = await getTags();
  } catch (err: any) {
    tags.value = [];
  } finally {
    tagsLoading.value = false;
  }
}

/**
 * 按类型加载文档列表
 */
async function loadData() {
  loading.value = true;
  error.value = null;
  documents.value = [];
  try {
    let list: DocumentListItem[] = [];
    switch (quickType.value) {
      case 'recent':
        list = await getRecentDocuments(50);
        break;
      case 'favorites':
        list = await getFavorites();
        break;
      case 'my':
        list = await getMyDocuments();
        break;
      case 'my-org':
        list = await getMyOrgDocuments();
        break;
      case 'tag': {
        // 标签类型：取全部可见文档后在内存按 tag 过滤
        // 后端未提供按标签筛选接口，用 getRecentDocuments(50) 兜底
        // 精确做法是后端加接口，此处先内存过滤
        const all = await getRecentDocuments(50);
        const t = tagName.value;
        list = t ? all.filter((d) => (d.tags ?? []).includes(t)) : all;
        break;
      }
    }
    documents.value = list ?? [];
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? '加载失败';
    error.value = msg;
  } finally {
    loading.value = false;
  }
}

function goTag(t: string) {
  router.push(`/quick/tag?t=${encodeURIComponent(t)}`);
}

watch(
  () => [route.params.type, route.query.t],
  () => {
    loadData();
    if (quickType.value === 'tag') loadTags();
  },
);

onMounted(() => {
  loadData();
  if (quickType.value === 'tag') loadTags();
});
</script>

<template>
  <div class="quick-view">
    <header class="page-header">
      <el-button text @click="goBack" class="back-btn">
        <el-icon><ArrowLeft /></el-icon>
      </el-button>
      <el-icon size="22" class="header-icon">
        <component :is="meta.icon" />
      </el-icon>
      <h1>{{ meta.title }}</h1>
      <span class="header-desc">{{ meta.desc }}</span>
    </header>

    <!-- 标签云（仅 type=tag 显示在顶部） -->
    <section v-if="quickType === 'tag'" class="tag-cloud" v-loading="tagsLoading">
      <button
        v-for="t in tags"
        :key="t.tag"
        class="tag-chip"
        :class="{ active: t.tag === tagName }"
        @click="goTag(t.tag)"
      >
        {{ t.tag }}
        <span class="tag-count">{{ t.count }}</span>
      </button>
    </section>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="err" />

    <!-- 文档列表 -->
    <div class="doc-list" v-loading="loading">
      <div
        v-for="row in documents"
        :key="row.id"
        class="doc-row"
        @click="goDoc(row.id)"
      >
        <div class="doc-title-wrap">
          <el-icon v-if="row.favorited" class="fav-icon" title="已收藏"><StarFilled /></el-icon>
          <el-link type="primary" underline="never" class="doc-title">{{ row.title }}</el-link>
        </div>
        <el-tag :type="getFormatTagType(row.format)" size="small" effect="light">
          {{ row.format }}
        </el-tag>
        <span v-if="row.createdByName" class="doc-author">{{ row.createdByName }}</span>
        <span class="doc-time">{{ formatTime(row.updatedAt) }}</span>
        <span class="doc-version">v{{ row.version }}</span>
      </div>
      <el-empty
        v-if="!loading && documents.length === 0"
        description="暂无文档"
        :image-size="80"
      />
    </div>
  </div>
</template>

<style scoped>
.quick-view {
  padding: 24px;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
}
.page-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
}
.back-btn {
  padding: 4px;
}
.header-icon {
  color: #4f8cff;
}
.page-header h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: #1f2937;
}
.header-desc {
  font-size: 13px;
  color: #9ca3af;
  margin-left: 4px;
}

/* 标签云 */
.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 20px;
  padding: 16px;
  background: #fff;
  border: 1px solid #eef0f4;
  border-radius: 10px;
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
  color: #4b5563;
  transition: all 0.15s;
}
.tag-chip:hover {
  border-color: #4f8cff;
  color: #4f8cff;
  background: #f0f6ff;
}
.tag-chip.active {
  background: linear-gradient(135deg, #4f8cff, #7c5cff);
  color: #fff;
  border-color: transparent;
}
.tag-count {
  font-size: 11px;
  background: rgba(0, 0, 0, 0.08);
  padding: 1px 6px;
  border-radius: 8px;
}
.tag-chip.active .tag-count {
  background: rgba(255, 255, 255, 0.25);
}

.err {
  margin-bottom: 16px;
}

/* 文档列表 */
.doc-list {
  background: #fff;
  border: 1px solid #eef0f4;
  border-radius: 12px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.doc-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.doc-row:hover {
  background: #f8faff;
}
.doc-title-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.fav-icon {
  color: #f59e0b;
  flex-shrink: 0;
  font-size: 16px;
}
.doc-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc-author {
  font-size: 12px;
  color: #6b7280;
  flex-shrink: 0;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc-time {
  font-size: 12px;
  color: #9ca3af;
  flex-shrink: 0;
}
.doc-version {
  font-size: 12px;
  color: #9ca3af;
  background: #f3f4f6;
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}
</style>

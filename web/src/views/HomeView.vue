<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  getCategoriesTree,
  CategoryTypes,
  type Category,
  type CategoryType,
} from '@/api/categories';
import {
  getRecentDocuments,
  getFavorites,
  getMyDocuments,
  getTags,
  type DocumentFormat,
  type DocumentListItem,
} from '@/api/documents';

const router = useRouter();

// 数据
const topCategories = ref<Category[]>([]);
const recentDocs = ref<DocumentListItem[]>([]);
const favoriteDocs = ref<DocumentListItem[]>([]);
const myDocs = ref<DocumentListItem[]>([]);
const tags = ref<{ tag: string; count: number }[]>([]);
const loading = ref(false);

// 分类卡片样式
interface CategoryStyle {
  icon: string;
  desc: string;
  color: string;
  gradient: string;
}
const categoryStyleMap: Record<string, CategoryStyle> = {
  tech_doc: {
    icon: 'Files',
    desc: '技术规格、API 文档、架构说明',
    color: '#4f8cff',
    gradient: 'linear-gradient(135deg, #4f8cff 0%, #6aa9ff 100%)',
  },
  solution: {
    icon: 'MagicStick',
    desc: '实施方案、最佳实践、案例总结',
    color: '#22c55e',
    gradient: 'linear-gradient(135deg, #22c55e 0%, #4ade80 100%)',
  },
  bug_report: {
    icon: 'Warning',
    desc: '问题分析、复现步骤、修复记录',
    color: '#f59e0b',
    gradient: 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)',
  },
  regulation: {
    icon: 'Document',
    desc: '公司制度、规范标准、流程要求',
    color: '#8b5cf6',
    gradient: 'linear-gradient(135deg, #8b5cf6 0%, #a78bfa 100%)',
  },
  dept_public: {
    icon: 'OfficeBuilding',
    desc: '部门通知、公共信息、共享资料',
    color: '#06b6d4',
    gradient: 'linear-gradient(135deg, #06b6d4 0%, #22d3ee 100%)',
  },
  key_project: {
    icon: 'Flag',
    desc: '重点项目文档、里程碑、交付物',
    color: '#ef4444',
    gradient: 'linear-gradient(135deg, #ef4444 0%, #f87171 100%)',
  },
  os_knowledge: {
    icon: 'Monitor',
    desc: '操作系统原理、命令、配置知识',
    color: '#0ea5e9',
    gradient: 'linear-gradient(135deg, #0ea5e9 0%, #38bdf8 100%)',
  },
  training: {
    icon: 'Reading',
    desc: '培训课件、教程、学习材料',
    color: '#14b8a6',
    gradient: 'linear-gradient(135deg, #14b8a6 0%, #2dd4bf 100%)',
  },
  eng_issues: {
    icon: 'Tools',
    desc: '工程问题、排查记录、解决方案',
    color: '#f97316',
    gradient: 'linear-gradient(135deg, #f97316 0%, #fb923c 100%)',
  },
  key_bug: {
    icon: 'CircleClose',
    desc: '重要缺陷、影响分析、修复追踪',
    color: '#dc2626',
    gradient: 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)',
  },
  newcomer: {
    icon: 'User',
    desc: '新人入职、入门指南、上手资料',
    color: '#ec4899',
    gradient: 'linear-gradient(135deg, #ec4899 0%, #f472b6 100%)',
  },
};
const defaultStyle: CategoryStyle = {
  icon: 'Folder',
  desc: '',
  color: '#6b7280',
  gradient: 'linear-gradient(135deg, #6b7280 0%, #9ca3af 100%)',
};
function getStyle(cat: Category): CategoryStyle {
  return cat.type ? categoryStyleMap[cat.type] ?? defaultStyle : defaultStyle;
}

// 类型排序：已知类型按预定义顺序，未知类型按 sort 字段
const typeOrder: string[] = Object.values(CategoryTypes);
const sortedTopCategories = computed<Category[]>(() => {
  return [...topCategories.value].sort((a, b) => {
    const ia = a.type ? typeOrder.indexOf(a.type) : -1;
    const ib = b.type ? typeOrder.indexOf(b.type) : -1;
    // 已知类型按预定义顺序（ia/ib >= 0），未知类型按 sort 字段
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return (a.sort ?? 0) - (b.sort ?? 0);
  });
});

// 快捷入口卡片
const quickCards = computed(() => [
  {
    key: 'recent',
    icon: 'Clock',
    title: '最近更新',
    count: recentDocs.value.length,
    color: '#4f8cff',
    gradient: 'linear-gradient(135deg, #4f8cff, #6aa9ff)',
    desc: '近期编辑的所有文档',
  },
  {
    key: 'favorites',
    icon: 'StarFilled',
    title: '我的收藏',
    count: favoriteDocs.value.length,
    color: '#f59e0b',
    gradient: 'linear-gradient(135deg, #f59e0b, #fbbf24)',
    desc: '星标收藏的文档',
  },
  {
    key: 'my',
    icon: 'User',
    title: '我的文档',
    count: myDocs.value.length,
    color: '#22c55e',
    gradient: 'linear-gradient(135deg, #22c55e, #4ade80)',
    desc: '我创建的所有文档',
  },
]);

function goQuick(key: string) {
  router.push(`/quick/${key}`);
}

function goTag(t: string) {
  router.push(`/quick/tag?t=${encodeURIComponent(t)}`);
}

function getFormatTagType(
  fmt: DocumentFormat,
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

function enterCategory(id: string) {
  router.push(`/c/${id}`);
}
function goDoc(id: string) {
  router.push(`/d/${id}`);
}

onMounted(async () => {
  loading.value = true;
  try {
    const [tree, recent, favs, mine, tagList] = await Promise.all([
      getCategoriesTree().catch(() => [] as Category[]),
      getRecentDocuments(10).catch(() => [] as DocumentListItem[]),
      getFavorites().catch(() => [] as DocumentListItem[]),
      getMyDocuments().catch(() => [] as DocumentListItem[]),
      getTags().catch(() => [] as { tag: string; count: number }[]),
    ]);
    topCategories.value = tree ?? [];
    recentDocs.value = recent ?? [];
    favoriteDocs.value = favs ?? [];
    myDocs.value = mine ?? [];
    tags.value = tagList ?? [];
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? '加载失败';
    ElMessage.error(`加载失败：${msg}`);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="home" v-loading="loading">
    <!-- 欢迎横幅 -->
    <section class="hero">
      <div class="hero-content">
        <h1>LXDOC 企业知识库</h1>
        <p class="subtitle">技术文档 · 解决方案 · Bug 分析 · AI 智能总结</p>
      </div>
      <div class="hero-stats">
        <div class="stat">
          <span class="stat-num">{{ topCategories.length }}</span>
          <span class="stat-label">分类</span>
        </div>
        <div class="stat">
          <span class="stat-num">{{ recentDocs.length }}</span>
          <span class="stat-label">近期更新</span>
        </div>
        <div class="stat">
          <span class="stat-num">{{ favoriteDocs.length }}</span>
          <span class="stat-label">收藏</span>
        </div>
      </div>
    </section>

    <!-- 快捷入口卡片 -->
    <section class="block">
      <div class="block-header">
        <h2 class="block-title">快捷入口</h2>
      </div>
      <div class="quick-grid">
        <div
          v-for="card in quickCards"
          :key="card.key"
          class="quick-card"
          :style="{ '--card-color': card.color, '--card-gradient': card.gradient }"
          @click="goQuick(card.key)"
        >
          <div class="quick-icon">
            <el-icon size="22"><component :is="card.icon" /></el-icon>
          </div>
          <div class="quick-body">
            <div class="quick-title">{{ card.title }}</div>
            <div class="quick-desc">{{ card.desc }}</div>
          </div>
          <div class="quick-count">
            <span class="num">{{ card.count }}</span>
            <span class="unit">篇</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 知识分区 -->
    <section class="block">
      <div class="block-header">
        <h2 class="block-title">知识分区</h2>
      </div>
      <div class="cat-grid">
        <div
          v-for="cat in sortedTopCategories"
          :key="cat.id"
          class="cat-card"
          :style="{ '--card-color': getStyle(cat).color, '--card-gradient': getStyle(cat).gradient }"
          @click="enterCategory(cat.id)"
        >
          <div class="cat-icon-wrap">
            <el-icon size="22"><component :is="getStyle(cat).icon" /></el-icon>
          </div>
          <div class="cat-body">
            <div class="cat-name">{{ cat.name }}</div>
            <div class="cat-desc">{{ getStyle(cat).desc }}</div>
          </div>
          <el-icon class="cat-arrow"><ArrowRight /></el-icon>
        </div>
        <div v-if="sortedTopCategories.length === 0" class="cat-empty">
          <el-empty description="暂无分类，请在左侧分类树右键新建" :image-size="80" />
        </div>
      </div>
    </section>

    <!-- 最近更新 + 标签云 -->
    <div class="two-col">
      <!-- 最近更新 -->
      <section class="block">
        <div class="block-header">
          <h2 class="block-title">最近更新</h2>
          <el-link type="primary" underline="never" class="more-link" @click="goQuick('recent')">
            查看更多
          </el-link>
        </div>
        <div class="recent-list">
          <div
            v-for="row in recentDocs.slice(0, 6)"
            :key="row.id"
            class="recent-row"
            @click="goDoc(row.id)"
          >
            <el-icon v-if="row.favorited" class="row-fav"><StarFilled /></el-icon>
            <div class="recent-title">
              <el-link type="primary" underline="never">{{ row.title }}</el-link>
            </div>
            <el-tag :type="getFormatTagType(row.format)" size="small" effect="light">
              {{ row.format }}
            </el-tag>
            <span class="recent-time">{{ formatTime(row.updatedAt) }}</span>
          </div>
          <el-empty
            v-if="recentDocs.length === 0"
            description="暂无文档"
            :image-size="60"
          />
        </div>
      </section>

      <!-- 标签云 -->
      <section class="block">
        <div class="block-header">
          <h2 class="block-title">标签云</h2>
        </div>
        <div class="tag-cloud">
          <button
            v-for="t in tags"
            :key="t.tag"
            class="tag-chip"
            @click="goTag(t.tag)"
          >
            {{ t.tag }}
            <span class="tag-count">{{ t.count }}</span>
          </button>
          <el-empty
            v-if="tags.length === 0"
            description="暂无标签"
            :image-size="60"
          />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  padding: var(--lx-space-6);
  gap: var(--lx-space-5);
  height: 100%;
  overflow: auto;
  background: var(--lx-bg);
  color: var(--lx-text);
  box-sizing: border-box;
}

/* 欢迎横幅 */
.hero {
  background: var(--lx-gradient-hero);
  color: var(--lx-text-inverse);
  border-radius: var(--lx-radius-xl);
  padding: var(--lx-space-8) var(--lx-space-8);
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: var(--lx-shadow-lg);
}
.hero h1 {
  margin: 0 0 var(--lx-space-2);
  font-size: var(--lx-font-3xl);
  letter-spacing: 1px;
  background: linear-gradient(90deg, #ffffff, #c7d2fe);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.subtitle {
  margin: 0;
  font-size: var(--lx-font-sm);
  opacity: 0.8;
}
.hero-stats {
  display: flex;
  gap: var(--lx-space-8);
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.stat-num {
  font-size: var(--lx-font-3xl);
  font-weight: var(--lx-font-bold);
}
.stat-label {
  font-size: var(--lx-font-xs);
  opacity: 0.7;
}

/* 通用 block */
.block {
  background: var(--lx-bg-elevated);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-lg);
  padding: var(--lx-space-5);
  box-shadow: var(--lx-shadow-sm);
}
.block-header {
  display: flex;
  align-items: center;
  margin-bottom: var(--lx-space-4);
}
.block-title {
  margin: 0;
  font-size: var(--lx-font-lg);
  font-weight: var(--lx-font-semibold);
  color: var(--lx-text);
  flex: 1;
}
.more-link {
  font-size: var(--lx-font-sm);
}

/* 快捷入口卡片 */
.quick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--lx-space-3);
}
.quick-card {
  display: flex;
  align-items: center;
  gap: var(--lx-space-4);
  padding: var(--lx-space-4) var(--lx-space-5);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-md);
  cursor: pointer;
  transition: all var(--lx-transition);
  background: var(--lx-bg-elevated);
}
.quick-card:hover {
  border-color: var(--card-color);
  box-shadow: var(--lx-shadow-md);
  transform: translateY(-2px);
}
.quick-icon {
  width: 44px;
  height: 44px;
  border-radius: var(--lx-radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--lx-text-inverse);
  background: var(--card-gradient);
  flex-shrink: 0;
}
.quick-body {
  flex: 1;
  min-width: 0;
}
.quick-title {
  font-size: var(--lx-font-md);
  font-weight: var(--lx-font-semibold);
  color: var(--lx-text);
  margin-bottom: var(--lx-space-1);
}
.quick-desc {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
}
.quick-count {
  display: flex;
  align-items: baseline;
  gap: 2px;
  flex-shrink: 0;
}
.quick-count .num {
  font-size: var(--lx-font-xl);
  font-weight: var(--lx-font-bold);
  color: var(--card-color);
}
.quick-count .unit {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
}

/* 分类卡片 */
.cat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--lx-space-3);
}
.cat-card {
  display: flex;
  align-items: center;
  gap: var(--lx-space-4);
  padding: var(--lx-space-4) var(--lx-space-5);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-md);
  cursor: pointer;
  transition: all var(--lx-transition);
  background: var(--lx-bg-elevated);
}
.cat-card:hover {
  border-color: var(--card-color);
  box-shadow: var(--lx-shadow-md);
  transform: translateY(-2px);
}
.cat-icon-wrap {
  width: 44px;
  height: 44px;
  border-radius: var(--lx-radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--lx-text-inverse);
  background: var(--card-gradient);
  flex-shrink: 0;
}
.cat-body {
  flex: 1;
  min-width: 0;
}
.cat-name {
  font-size: var(--lx-font-md);
  font-weight: var(--lx-font-semibold);
  color: var(--lx-text);
  margin-bottom: var(--lx-space-1);
}
.cat-desc {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
  line-height: 1.4;
}
.cat-arrow {
  color: var(--lx-border-strong);
  transition: all var(--lx-transition);
}
.cat-card:hover .cat-arrow {
  color: var(--card-color);
  transform: translateX(2px);
}
.cat-empty {
  grid-column: 1 / -1;
}

/* 双栏布局 */
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--lx-space-5);
}
@media (max-width: 900px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}

/* 最近更新列表 */
.recent-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.recent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--lx-radius-md);
  cursor: pointer;
  transition: background var(--lx-transition-fast);
}
.recent-row:hover {
  background: var(--lx-primary-50);
}
.row-fav {
  color: var(--lx-warning);
  flex-shrink: 0;
  font-size: var(--lx-font-base);
}
.recent-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-time {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
  flex-shrink: 0;
}

/* 标签云 */
.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: var(--lx-space-2);
  min-height: 60px;
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--lx-space-2);
  padding: var(--lx-space-2) var(--lx-space-3);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-pill);
  background: var(--lx-bg-elevated);
  cursor: pointer;
  font-size: var(--lx-font-sm);
  color: var(--lx-text-regular);
  transition: all var(--lx-transition-fast);
}
.tag-chip:hover {
  border-color: var(--lx-primary);
  color: var(--lx-primary);
  background: var(--lx-primary-50);
}
.tag-count {
  font-size: var(--lx-font-xs);
  background: var(--lx-bg-subtle);
  padding: 1px 6px;
  border-radius: var(--lx-radius-pill);
}
</style>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  getCategoriesTree,
  type Category,
  type CategoryType,
} from '@/api/categories';
import {
  getRecentDocuments,
  type DocumentFormat,
  type DocumentListItem,
} from '@/api/documents';

const router = useRouter();

// 顶层分类列表
const topCategories = ref<Category[]>([]);
// 最近更新文档
const recentDocs = ref<DocumentListItem[]>([]);
const recentLoading = ref(false);

// 不同分类类型对应的卡片配色与图标
interface CategoryStyle {
  icon: string;
  desc: string;
  color: string;
  borderColor: string;
  bg: string;
}

const categoryStyleMap: Record<CategoryType, CategoryStyle> = {
  tech_doc: {
    icon: '📘',
    desc: '技术规格、API 文档、架构说明',
    color: '#409eff',
    borderColor: '#d9ecff',
    bg: '#ecf5ff',
  },
  solution: {
    icon: '🟢',
    desc: '实施方案、最佳实践、案例总结',
    color: '#67c23a',
    borderColor: '#b3e19d',
    bg: '#f0f9eb',
  },
  bug_report: {
    icon: '🐞',
    desc: '问题分析、复现步骤、修复记录',
    color: '#e6a23c',
    borderColor: '#f5dab1',
    bg: '#fdf6ec',
  },
};

// 默认样式（用于 type 为 null 的顶层分类）
const defaultStyle: CategoryStyle = {
  icon: '📁',
  desc: '',
  color: '#909399',
  borderColor: '#e4e7ed',
  bg: '#f5f7fa',
};

function getStyle(cat: Category): CategoryStyle {
  return cat.type ? categoryStyleMap[cat.type] ?? defaultStyle : defaultStyle;
}

// 按类型排序，确保三个顶层卡片顺序固定：技术文档 → 解决方案 → Bug 分析报告
const typeOrder: CategoryType[] = ['tech_doc', 'solution', 'bug_report'];
const sortedTopCategories = computed<Category[]>(() => {
  return [...topCategories.value].sort((a, b) => {
    const ia = a.type ? typeOrder.indexOf(a.type) : 99;
    const ib = b.type ? typeOrder.indexOf(b.type) : 99;
    return ia - ib;
  });
});

// 不同格式对应的 el-tag 类型（与 CategoryView 一致：md/docx=蓝、txt=灰、odt=绿、pdf=红）
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

// 时间格式化
function formatTime(s: string | Date): string {
  if (!s) return '';
  const d = typeof s === 'string' ? new Date(s) : s;
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 进入分类
 */
function enterCategory(id: string) {
  router.push(`/c/${id}`);
}

/**
 * 跳转文档详情
 */
function goDoc(id: string) {
  router.push(`/d/${id}`);
}

onMounted(async () => {
  try {
    const tree = await getCategoriesTree();
    topCategories.value = tree ?? [];
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '加载分类失败';
    ElMessage.error(`加载分类失败：${msg}`);
  }

  recentLoading.value = true;
  try {
    recentDocs.value = (await getRecentDocuments(10)) ?? [];
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '加载最近更新失败';
    ElMessage.error(`加载最近更新失败：${msg}`);
    recentDocs.value = [];
  } finally {
    recentLoading.value = false;
  }
});
</script>

<template>
  <div class="home">
    <!-- 欢迎区 -->
    <section class="hero">
      <h1>LXDOC 企业知识库</h1>
      <p class="subtitle">技术文档 · 解决方案 · Bug 分析报告</p>
    </section>

    <!-- 顶层分类入口卡片 -->
    <section class="section">
      <el-row :gutter="16">
        <el-col
          v-for="cat in sortedTopCategories"
          :key="cat.id"
          :xs="24"
          :sm="12"
          :md="8"
        >
          <div
            class="cat-card"
            :style="{
              borderColor: getStyle(cat).borderColor,
              background: getStyle(cat).bg,
            }"
          >
            <div class="cat-icon">{{ getStyle(cat).icon }}</div>
            <div class="cat-body">
              <div class="cat-name" :style="{ color: getStyle(cat).color }">
                {{ cat.name }}
              </div>
              <div class="cat-desc">{{ getStyle(cat).desc }}</div>
            </div>
            <el-button
              type="primary"
              plain
              size="small"
              :style="{ color: getStyle(cat).color, borderColor: getStyle(cat).color }"
              @click="enterCategory(cat.id)"
            >
              进入
            </el-button>
          </div>
        </el-col>
        <el-col
          v-if="sortedTopCategories.length === 0"
          :span="24"
        >
          <el-empty description="暂无分类，请在左侧分类树右键新建" />
        </el-col>
      </el-row>
    </section>

    <!-- 最近更新 -->
    <section class="section">
      <h2 class="section-title">最近更新</h2>
      <el-table
        :data="recentDocs"
        v-loading="recentLoading"
        style="width: 100%"
        stripe
        empty-text="暂无文档，请从左侧分类进入并上传"
      >
        <el-table-column label="标题" min-width="240" show-overflow-tooltip>
          <template #default="{ row }">
            <el-link type="primary" :underline="false" @click="goDoc(row.id)">
              {{ row.title }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="格式" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="getFormatTagType(row.format)" size="small">
              {{ row.format }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最后修改" width="180">
          <template #default="{ row }">
            {{ formatTime(row.updatedAt) }}
          </template>
        </el-table-column>
        <el-table-column label="版本" width="90" align="center">
          <template #default="{ row }">v{{ row.version }}</template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无文档，请从左侧分类进入并上传" />
        </template>
      </el-table>
    </section>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  padding: 24px;
  gap: 24px;
  height: 100%;
  overflow: auto;
  background: #f5f7fa;
  color: #303133;
  box-sizing: border-box;
}
.hero {
  background: linear-gradient(135deg, #001529 0%, #003a70 100%);
  color: #fff;
  border-radius: 8px;
  padding: 32px 24px;
}
.hero h1 {
  margin: 0 0 8px;
  font-size: 28px;
  letter-spacing: 1px;
}
.hero .subtitle {
  margin: 0;
  font-size: 14px;
  opacity: 0.85;
}
.section {
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 20px;
}
.section-title {
  margin: 0 0 16px;
  font-size: 18px;
  font-weight: 600;
  color: #303133;
}
.cat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  margin-bottom: 12px;
  transition: box-shadow 0.2s, transform 0.2s;
}
.cat-card:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  transform: translateY(-1px);
}
.cat-icon {
  font-size: 28px;
  flex-shrink: 0;
}
.cat-body {
  flex: 1;
  min-width: 0;
}
.cat-name {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}
.cat-desc {
  font-size: 12px;
  color: #909399;
  line-height: 1.4;
}
</style>

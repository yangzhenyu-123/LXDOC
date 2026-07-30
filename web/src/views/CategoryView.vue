<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { UploadFile, UploadInstance, UploadUserFile } from 'element-plus';
import { getCategoriesTree, type Category } from '@/api/categories';
import { uploadDocument } from '@/api/uploads';
import {
  listByCategory,
  type DocumentFormat,
  type DocumentListItem,
} from '@/api/documents';

const route = useRoute();
const router = useRouter();
const categoryId = computed(() => String(route.params.categoryId ?? ''));
const tree = ref<Category[]>([]);

// 递归查找分类节点
function findCategory(nodes: Category[], id: string): Category | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children?.length) {
      const found = findCategory(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

const current = computed(() => findCategory(tree.value, categoryId.value));

// 文档列表
const documents = ref<DocumentListItem[]>([]);
const loading = ref(false);

// 格式筛选选项（与后端 DocumentFormat 对齐）
const formatOptions: { value: DocumentFormat; label: string }[] = [
  { value: 'md', label: 'md' },
  { value: 'txt', label: 'txt' },
  { value: 'docx', label: 'docx' },
  { value: 'odt', label: 'odt' },
  { value: 'pdf', label: 'pdf' },
];

// 当前选中的格式 / 标签
const selectedFormats = ref<DocumentFormat[]>([]);
const selectedTags = ref<string[]>([]);

// 从当前列表文档的 tags 中聚合去重作为标签筛选选项
const tagOptions = computed<string[]>(() => {
  const set = new Set<string>();
  for (const doc of documents.value) {
    for (const t of doc.tags ?? []) set.add(t);
  }
  return Array.from(set).sort();
});

// 经过筛选后的列表
const filteredDocuments = computed<DocumentListItem[]>(() => {
  return documents.value.filter((d) => {
    if (
      selectedFormats.value.length > 0 &&
      !selectedFormats.value.includes(d.format)
    ) {
      return false;
    }
    if (selectedTags.value.length > 0) {
      const docTags = d.tags ?? [];
      // 文档标签需包含所有选中的标签（AND 语义）
      const allMatch = selectedTags.value.every((t) => docTags.includes(t));
      if (!allMatch) return false;
    }
    return true;
  });
});

// 不同格式对应的 el-tag 类型
// el-tag 的 type 仅接受 '' | 'success' | 'info' | 'warning' | 'danger'，无 primary，故把 md/docx 映射为 ''
function getFormatTagType(
  fmt: DocumentFormat,
): '' | 'success' | 'info' | 'warning' | 'danger' {
  switch (fmt) {
    case 'md':
    case 'docx':
      return ''; // 蓝色（默认）
    case 'txt':
      return 'info'; // 灰
    case 'odt':
      return 'success'; // 绿
    case 'pdf':
      return 'danger'; // 红
    default:
      return '';
  }
}

// 格式 tag 文字颜色（用于加深观感）
function getFormatTagColor(fmt: DocumentFormat): string {
  switch (fmt) {
    case 'md':
    case 'docx':
      return '#409eff'; // 蓝
    case 'txt':
      return '#909399'; // 灰
    case 'odt':
      return '#67c23a'; // 绿
    case 'pdf':
      return '#f56c6c'; // 红
    default:
      return '#409eff';
  }
}

// 时间格式化
function formatTime(s: string | Date): string {
  if (!s) return '';
  const d = typeof s === 'string' ? new Date(s) : s;
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString('zh-CN', { hour12: false });
}

// 清空筛选
function clearFilters() {
  selectedFormats.value = [];
  selectedTags.value = [];
}

/**
 * 加载当前分类（含子分类）下的文档列表
 */
async function loadDocuments() {
  if (!categoryId.value) return;
  loading.value = true;
  try {
    documents.value =
      (await listByCategory(categoryId.value, true)) ?? [];
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '加载文档列表失败';
    ElMessage.error(`加载文档列表失败：${msg}`);
    documents.value = [];
  } finally {
    loading.value = false;
  }
}

// 上传对话框状态
const uploadRef = ref<UploadInstance>();
const uploadDialog = ref({
  visible: false,
  loading: false,
});
// el-upload 的文件列表
const fileList = ref<UploadUserFile[]>([]);
// 当前选中的原始 File 对象
const selectedFile = ref<File | null>(null);

function openUploadDialog() {
  if (!categoryId.value) {
    ElMessage.warning('请先选择一个分类');
    return;
  }
  selectedFile.value = null;
  fileList.value = [];
  uploadDialog.value.visible = true;
}

// el-upload 文件变化回调：保存第一个文件的 raw
function onFileChange(file: UploadFile) {
  selectedFile.value = file.raw ?? null;
}

// 删除文件回调：清空选中
function onFileRemove() {
  selectedFile.value = null;
}

// 超出 limit=1 限制时提示
function onExceed() {
  ElMessage.warning('一次只能上传一个文件，请先移除已选文件');
}

// 确认上传
async function submitUpload() {
  if (!selectedFile.value) {
    ElMessage.warning('请先选择要上传的文件');
    return;
  }
  if (!categoryId.value) {
    ElMessage.warning('缺少分类 id');
    return;
  }
  uploadDialog.value.loading = true;
  try {
    await uploadDocument(selectedFile.value, categoryId.value);
    ElMessage.success('文档上传成功');
    uploadDialog.value.visible = false;
    selectedFile.value = null;
    fileList.value = [];
    uploadRef.value?.clearFiles();
    // 上传成功后刷新文档列表
    await loadDocuments();
  } catch (err: any) {
    // 400 / 其他错误：优先展示后端返回的 message
    const msg =
      err?.response?.data?.message ?? err?.message ?? '上传失败，请稍后重试';
    ElMessage.error(`上传失败：${msg}`);
  } finally {
    uploadDialog.value.loading = false;
  }
}

// 跳转到文档详情
function goDoc(id: string) {
  router.push(`/d/${id}`);
}

// 监听路由参数变化，重新加载文档列表
watch(
  () => route.params.categoryId,
  () => {
    loadDocuments();
  },
);

onMounted(async () => {
  try {
    tree.value = (await getCategoriesTree()) ?? [];
  } catch {
    // 忽略错误，占位页面仍可显示原始 id
  }
  await loadDocuments();
});
</script>

<template>
  <div class="category-view">
    <div class="toolbar">
      <h2>分类：{{ current?.name ?? categoryId }}</h2>
      <el-button type="primary" @click="openUploadDialog">
        <el-icon class="el-icon--left"><Upload /></el-icon>
        上传文档
      </el-button>
    </div>

    <!-- 筛选区 -->
    <div class="filters">
      <el-select
        v-model="selectedFormats"
        multiple
        collapse-tags
        collapse-tags-tooltip
        clearable
        placeholder="格式筛选"
        class="filter-item"
        style="width: 220px"
      >
        <el-option
          v-for="opt in formatOptions"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
        />
      </el-select>
      <el-select
        v-model="selectedTags"
        multiple
        collapse-tags
        collapse-tags-tooltip
        clearable
        placeholder="标签筛选"
        class="filter-item"
        style="width: 260px"
        :no-data-text="'暂无标签'"
      >
        <el-option
          v-for="tag in tagOptions"
          :key="tag"
          :label="tag"
          :value="tag"
        />
      </el-select>
      <el-button @click="clearFilters">清空筛选</el-button>
      <span class="filter-count">
        共 {{ filteredDocuments.length }} / {{ documents.length }} 篇
      </span>
    </div>

    <!-- 文档表格 -->
    <el-table
      :data="filteredDocuments"
      v-loading="loading"
      style="width: 100%"
      stripe
      empty-text="该分类下暂无文档，点击上方上传按钮添加"
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
          <el-tag
            :type="getFormatTagType(row.format)"
            :style="{ color: getFormatTagColor(row.format) }"
            size="small"
          >
            {{ row.format }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="标签" min-width="200">
        <template #default="{ row }">
          <template v-if="row.tags && row.tags.length">
            <el-tag
              v-for="tag in row.tags"
              :key="tag"
              size="small"
              class="doc-tag"
              effect="plain"
            >
              {{ tag }}
            </el-tag>
          </template>
          <span v-else class="muted">—</span>
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
        <el-empty description="该分类下暂无文档，点击上方上传按钮添加" />
      </template>
    </el-table>

    <!-- 上传文档对话框 -->
    <el-dialog
      v-model="uploadDialog.visible"
      title="上传文档"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-upload
        ref="uploadRef"
        v-model:file-list="fileList"
        action="#"
        accept=".md,.markdown,.txt,.docx,.odt,.pdf"
        :auto-upload="false"
        :limit="1"
        :on-exceed="onExceed"
        :on-change="onFileChange"
        :on-remove="onFileRemove"
        drag
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">
          拖拽文件到此处，或 <em>点击选择</em>
        </div>
        <template #tip>
          <div class="upload-tip">
            支持 .md / .markdown / .txt / .docx / .odt / .pdf，单次单个文件
          </div>
        </template>
      </el-upload>
      <template #footer>
        <el-button
          :disabled="uploadDialog.loading"
          @click="uploadDialog.visible = false"
        >
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="uploadDialog.loading"
          :disabled="!selectedFile"
          @click="submitUpload"
        >
          确认上传
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.category-view {
  display: flex;
  flex-direction: column;
  padding: 24px;
  color: #303133;
  height: 100%;
  gap: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.category-view h2 {
  margin: 0;
}
.filters {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.filter-count {
  margin-left: auto;
  font-size: 13px;
  color: #909399;
}
.upload-tip {
  margin-top: 4px;
  color: #909399;
  font-size: 12px;
}
.doc-tag {
  margin-right: 4px;
  margin-bottom: 2px;
}
.muted {
  color: #c0c4cc;
}
</style>

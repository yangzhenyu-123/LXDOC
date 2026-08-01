<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { UploadFile, UploadInstance, UploadUserFile } from 'element-plus';
import { getCategoriesTree, type Category } from '@/api/categories';
import {
  uploadDocument,
  createCollection,
  type DocumentOwnerType,
} from '@/api/uploads';
import { uploadAttachmentFile } from '@/api/attachments';
import {
  listByCategory,
  deleteDocument,
  toggleFavorite as toggleFavoriteApi,
  type DocumentFormat,
  type DocumentListItem,
} from '@/api/documents';
import {
  listOrganizations,
  type Organization,
} from '@/api/organizations';
import { useAuthStore } from '@/stores/auth';
import { DOC_ACCEPT, ATTACH_ACCEPT } from '@/config/formats';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const categoryId = computed(() => String(route.params.categoryId ?? ''));
const tree = ref<Category[]>([]);

// 组织列表（用于上传时选择文档归属）
const orgList = ref<Organization[]>([]);
const orgMap = computed(() => new Map(orgList.value.map((o) => [o.id, o])));

// 当前用户的组织节点与所在部门（用于"我的组/我的部门"归属选项）
const userOrg = computed<Organization | null>(() => {
  const oid = authStore.user?.organizationId;
  return oid ? (orgMap.value.get(oid) ?? null) : null;
});
const userDept = computed<Organization | null>(() => {
  const org = userOrg.value;
  if (!org || !org.parentId) return null;
  return orgMap.value.get(org.parentId) ?? null;
});

// 组织 id → 完整路径展示
function orgPathLabel(orgId: string): string {
  const org = orgMap.value.get(orgId);
  if (!org) return '';
  if (!org.path) return org.name;
  const ids = org.path.split('.').filter(Boolean);
  const nameMap = new Map(orgList.value.map((o) => [o.id, o.name]));
  return ids.map((id) => nameMap.get(id) ?? id).join(' / ');
}

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
const attachUploadRef = ref<UploadInstance>();
const uploadDialog = ref({
  visible: false,
  loading: false,
  // 进度文本（多文档/附件上传时展示）
  progressText: '',
});
// 主文档文件列表（支持多个）
const fileList = ref<UploadUserFile[]>([]);
// 附件文件列表（独立区域）
const attachFileList = ref<UploadUserFile[]>([]);
// 是否创建文档集（勾选后多文档会引用到一个集合）
const createAsCollection = ref(false);
// 文档集标题（勾选创建集合时必填）
const collectionTitle = ref('');

// 文档归属选择
// - personal: 个人空间（默认）
// - myGroup: 我的组（用户 organizationId 指向的 group）
// - myDept: 我的部门（用户所在 group 的父 department）
// - custom: 任意组织（仅 admin，配合 customOrgId）
type OwnerChoice = 'personal' | 'myGroup' | 'myDept' | 'custom';
const ownerChoice = ref<OwnerChoice>('personal');
const customOrgId = ref<string>('');

// 当前选中的主文档文件数（从 fileList 派生）
const mainFileCount = computed(() => fileList.value.length);
const attachFileCount = computed(() => attachFileList.value.length);

// 附件区是否可用：
// - 单文档（1 个主文件）：可上传附件，附件挂到该文档
// - 多文档 + 勾选集合：可上传附件，附件挂到集合主文档（所有成员共享）
// - 多文档 + 不勾选集合：禁用（独立文档无附件）
const attachAreaEnabled = computed(
  () => mainFileCount.value === 1 || (mainFileCount.value > 1 && createAsCollection.value),
);
// 集合勾选项是否可用：仅当多文档时可勾选（单文档勾选集合无意义）
const collectionCheckboxEnabled = computed(() => mainFileCount.value > 1);
// 确认按钮是否可点：至少 1 个主文档文件；集合勾选时需标题
const canSubmit = computed(() => {
  if (mainFileCount.value === 0) return false;
  if (createAsCollection.value && !collectionTitle.value.trim()) return false;
  return true;
});

function openUploadDialog() {
  if (!categoryId.value) {
    ElMessage.warning('请先选择一个分类');
    return;
  }
  fileList.value = [];
  attachFileList.value = [];
  createAsCollection.value = false;
  collectionTitle.value = '';
  ownerChoice.value = 'personal';
  customOrgId.value = '';
  uploadDialog.value.progressText = '';
  uploadDialog.value.visible = true;
}

// 是否显示"我的组"选项
const showMyGroup = computed(
  () => !!userOrg.value && userOrg.value.type === 'group',
);
// 是否显示"我的部门"选项
const showMyDept = computed(() => !!userDept.value);
// 是否允许自定义选择任意组织（admin）
const allowCustomOrg = computed(() => authStore.isAdmin);

/**
 * 根据归属选择构造上传 owner 参数
 */
function buildOwner():
  | { type: DocumentOwnerType; id?: string | null }
  | undefined {
  switch (ownerChoice.value) {
    case 'personal':
      return { type: 'personal' };
    case 'myGroup':
      return userOrg.value
        ? { type: 'group', id: userOrg.value.id }
        : { type: 'personal' };
    case 'myDept':
      return userDept.value
        ? { type: 'department', id: userDept.value.id }
        : { type: 'personal' };
    case 'custom': {
      const org = customOrgId.value
        ? orgMap.value.get(customOrgId.value)
        : null;
      if (!org) return { type: 'personal' };
      return { type: org.type as DocumentOwnerType, id: org.id };
    }
    default:
      return undefined;
  }
}

// el-upload 文件变化/删除回调（主文档区，支持多文件）
function onMainFileChange(_file: UploadFile) {
  // fileList 由 v-model 双向绑定自动更新，无需手动维护
}
function onMainFileRemove() {
  // fileList 由 v-model 自动更新
}
function onMainExceed() {
  ElMessage.warning('如需替换文件，请先移除已选文件');
}

// 附件区文件变化回调
function onAttachFileChange(_file: UploadFile) {
  // fileList 由 v-model 自动更新
}
function onAttachFileRemove() {
  // fileList 由 v-model 自动更新
}

// 勾选集合时，若主文档只有 1 个，提示用户（不强制阻止）
watch(createAsCollection, (v) => {
  if (v && mainFileCount.value <= 1) {
    ElMessage.info('集合通常包含多个文档，单文档集合仅引用 1 个成员');
  }
});

/**
 * 确认上传
 *
 * 三种场景：
 * 1. 单文档（无集合）：POST /uploads 创建 1 个文档 → 逐个上传附件到该文档
 * 2. 多文档 + 集合：逐个 POST /uploads 创建 N 个文档 → POST /uploads/collection 创建集合主文档引用这 N 个 → 逐个上传附件到集合主文档
 * 3. 多文档 无集合：逐个 POST /uploads 创建 N 个独立文档（无附件）
 */
async function submitUpload() {
  if (!canSubmit.value) return;
  if (!categoryId.value) {
    ElMessage.warning('缺少分类 id');
    return;
  }
  if (ownerChoice.value === 'custom' && !customOrgId.value) {
    ElMessage.warning('请选择目标组织');
    return;
  }
  // 附件区禁用时不应有附件文件（防御性）
  if (!attachAreaEnabled.value && attachFileCount.value > 0) {
    ElMessage.warning('当前模式不支持附件，请移除附件区文件');
    return;
  }

  uploadDialog.value.loading = true;
  const owner = buildOwner();
  // 从 fileList 提取原始 File 对象（过滤未完成的）
  // UploadUserFile.raw 类型为 RawFileType（带 uid 的 File 扩展），可直接当 File 用
  const mainFiles = fileList.value
    .map((f) => f.raw)
    .filter((f) => !!f) as File[];
  const attachFiles = attachFileList.value
    .map((f) => f.raw)
    .filter((f) => !!f) as File[];

  try {
    let mainDocId: string | null = null;
    let createdDocIds: string[] = [];

    if (mainFiles.length === 1 && !createAsCollection.value) {
      // 场景 1：单文档（可能带附件）
      uploadDialog.value.progressText = '正在上传文档...';
      const resp = await uploadDocument(mainFiles[0], categoryId.value, owner);
      mainDocId = resp.id;
      createdDocIds = [resp.id];
    } else if (mainFiles.length > 1 && createAsCollection.value) {
      // 场景 2：多文档 + 集合
      // 2a. 逐个上传 N 个文档
      createdDocIds = [];
      for (let i = 0; i < mainFiles.length; i++) {
        uploadDialog.value.progressText = `正在上传文档 ${i + 1}/${mainFiles.length}...`;
        const resp = await uploadDocument(mainFiles[i], categoryId.value, owner);
        createdDocIds.push(resp.id);
      }
      // 2b. 创建集合主文档引用这 N 个文档
      uploadDialog.value.progressText = '正在创建文档集...';
      const title =
        collectionTitle.value.trim() ||
        `文档集 ${new Date().toLocaleString('zh-CN')}`;
      const collResp = await createCollection(
        title,
        categoryId.value,
        createdDocIds,
        owner,
      );
      mainDocId = collResp.id; // 附件挂到集合主文档
    } else {
      // 场景 3：多文档 无集合（独立文档，无附件）
      for (let i = 0; i < mainFiles.length; i++) {
        uploadDialog.value.progressText = `正在上传文档 ${i + 1}/${mainFiles.length}...`;
        const resp = await uploadDocument(mainFiles[i], categoryId.value, owner);
        createdDocIds.push(resp.id);
      }
    }

    // 上传附件（仅当有 mainDocId 且有附件文件）
    if (mainDocId && attachFiles.length > 0) {
      for (let i = 0; i < attachFiles.length; i++) {
        uploadDialog.value.progressText = `正在上传附件 ${i + 1}/${attachFiles.length}...`;
        await uploadAttachmentFile(mainDocId, attachFiles[i], i + 1);
      }
    }

    ElMessage.success(
      `上传成功：${createdDocIds.length} 个文档${
        attachFiles.length > 0 ? `，${attachFiles.length} 个附件` : ''
      }${createAsCollection.value ? '（已创建文档集）' : ''}`,
    );
    uploadDialog.value.visible = false;
    fileList.value = [];
    attachFileList.value = [];
    createAsCollection.value = false;
    collectionTitle.value = '';
    uploadRef.value?.clearFiles();
    attachUploadRef.value?.clearFiles();
    await loadDocuments();
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '上传失败，请稍后重试';
    ElMessage.error(`上传失败：${msg}`);
  } finally {
    uploadDialog.value.loading = false;
    uploadDialog.value.progressText = '';
  }
}

// 跳转到文档详情
function goDoc(id: string) {
  router.push(`/d/${id}`);
}

/**
 * 判断当前用户是否可删除指定文档
 * - admin 可删任意
 * - editor 仅可删自己 createdBy 的文档
 * - viewer 无删除权限
 */
function canDeleteDoc(doc: DocumentListItem): boolean {
  if (!authStore.user) return false;
  if (authStore.isAdmin) return true;
  if (authStore.isEditor && doc.createdBy === authStore.user.id) return true;
  return false;
}

/**
 * 删除文档：二次确认后调用接口，成功刷新列表
 */
async function handleDeleteDoc(doc: DocumentListItem) {
  try {
    await ElMessageBox.confirm(
      `确认删除文档「${doc.title}」？此操作不可恢复，将一并删除其所有历史版本与附件。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await deleteDocument(doc.id);
    ElMessage.success('文档已删除');
    await loadDocuments();
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '删除文档失败';
    ElMessage.error(`删除文档失败：${msg}`);
  }
}

/**
 * 切换收藏状态（列表内联星标）
 */
async function handleToggleFavorite(doc: DocumentListItem) {
  try {
    const next = await toggleFavoriteApi(doc.id);
    doc.favorited = next;
    ElMessage.success(next ? '已收藏' : '已取消收藏');
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? '操作失败';
    ElMessage.error(msg);
  }
}

// 默认按更新时间倒序
const defaultSort = { prop: 'updatedAt', order: 'descending' };

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
  // 加载组织列表用于上传归属选择（失败不阻断）
  try {
    orgList.value = (await listOrganizations()) ?? [];
  } catch {
    orgList.value = [];
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
      :default-sort="defaultSort"
      empty-text="该分类下暂无文档，点击上方上传按钮添加"
    >
      <el-table-column label="" width="44" align="center">
        <template #default="{ row }">
          <el-icon
            class="fav-star"
            :class="{ active: row.favorited }"
            @click.stop="handleToggleFavorite(row)"
            :title="row.favorited ? '取消收藏' : '收藏'"
          >
            <StarFilled v-if="row.favorited" />
            <Star v-else />
          </el-icon>
        </template>
      </el-table-column>
      <el-table-column label="标题" min-width="240" show-overflow-tooltip prop="title" sortable>
        <template #default="{ row }">
          <el-link type="primary" underline="never" @click="goDoc(row.id)">
            {{ row.title }}
          </el-link>
        </template>
      </el-table-column>
      <el-table-column label="格式" width="100" align="center" prop="format" sortable>
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
      <el-table-column label="创建者" width="120" prop="createdByName" sortable>
        <template #default="{ row }">
          <span v-if="row.createdByName">{{ row.createdByName }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="最后修改" width="180" prop="updatedAt" sortable>
        <template #default="{ row }">
          {{ formatTime(row.updatedAt) }}
        </template>
      </el-table-column>
      <el-table-column label="版本" width="90" align="center" prop="version" sortable>
        <template #default="{ row }">v{{ row.version }}</template>
      </el-table-column>
      <el-table-column label="操作" width="100" align="center" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="canDeleteDoc(row)"
            type="danger"
            size="small"
            text
            @click="handleDeleteDoc(row)"
          >
            删除
          </el-button>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="该分类下暂无文档，点击上方上传按钮添加" />
      </template>
    </el-table>

    <!-- 上传文档对话框 -->
    <el-dialog
      v-model="uploadDialog.visible"
      title="上传文档"
      width="560px"
      :close-on-click-modal="false"
    >
      <!-- 主文档区：支持多文件 -->
      <div class="upload-section">
        <div class="upload-section-label">文档文件</div>
        <el-upload
          ref="uploadRef"
          v-model:file-list="fileList"
          action="#"
          :accept="DOC_ACCEPT"
          :auto-upload="false"
          multiple
          :on-exceed="onMainExceed"
          :on-change="onMainFileChange"
          :on-remove="onMainFileRemove"
          drag
        >
          <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
          <div class="el-upload__text">
            拖拽文件到此处，或 <em>点击选择</em>（可多选）
          </div>
          <template #tip>
            <div class="upload-tip">
              支持 .md / .txt / .docx / .odt / .pdf 及 office 全格式，可一次选择多个文件
            </div>
          </template>
        </el-upload>
      </div>

      <!-- 创建文档集勾选项（仅多文档时可勾选） -->
      <div class="collection-section" v-if="mainFileCount > 1">
        <el-checkbox v-model="createAsCollection" :disabled="!collectionCheckboxEnabled">
          创建为文档集（把这些文档引用到一个集合，类似文件夹）
        </el-checkbox>
        <el-input
          v-if="createAsCollection"
          v-model="collectionTitle"
          placeholder="文档集标题（留空则自动生成）"
          style="margin-top: 8px"
          clearable
        />
      </div>

      <!-- 附件区：独立区域，满足条件才能上传 -->
      <div class="upload-section">
        <div class="upload-section-label">
          附件文件
          <span class="upload-section-hint" v-if="!attachAreaEnabled">
            （{{ mainFileCount > 1 && !createAsCollection ? '多文档未创建集合时不支持附件' : '请先选择文档文件' }}）
          </span>
        </div>
        <el-upload
          ref="attachUploadRef"
          v-model:file-list="attachFileList"
          action="#"
          :accept="ATTACH_ACCEPT"
          :auto-upload="false"
          multiple
          :disabled="!attachAreaEnabled"
          :on-change="onAttachFileChange"
          :on-remove="onAttachFileRemove"
          drag
        >
          <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
          <div class="el-upload__text">
            拖拽附件到此处，或 <em>点击选择</em>
          </div>
          <template #tip>
            <div class="upload-tip">
              支持压缩包 / 源码 / 图片 / office 全格式；
              <template v-if="mainFileCount === 1">附件与该文档关联</template>
              <template v-else-if="createAsCollection">附件与集合所有成员关联</template>
              <template v-else>多文档未创建集合时不支持附件</template>
            </div>
          </template>
        </el-upload>
      </div>

      <!-- 文档归属选择：个人 / 我的组 / 我的部门 / 自定义（admin） -->
      <div class="owner-section">
        <div class="owner-label">文档归属</div>
        <el-radio-group v-model="ownerChoice" class="owner-radio-group">
          <el-radio value="personal">个人空间（仅自己可读）</el-radio>
          <el-radio v-if="showMyGroup" value="myGroup">
            我的组：{{ orgPathLabel(userOrg!.id) }}
          </el-radio>
          <el-radio v-if="showMyDept" value="myDept">
            我的部门：{{ userDept!.name }}
          </el-radio>
          <el-radio v-if="allowCustomOrg" value="custom">指定组织</el-radio>
        </el-radio-group>
        <el-select
          v-if="allowCustomOrg && ownerChoice === 'custom'"
          v-model="customOrgId"
          filterable
          placeholder="选择目标组织节点"
          style="width: 100%; margin-top: 8px"
        >
          <el-option
            v-for="o in orgList"
            :key="o.id"
            :label="`${o.type === 'department' ? '部门' : '组'} · ${orgPathLabel(o.id)}`"
            :value="o.id"
          />
        </el-select>
        <div class="owner-tip">
          归属决定读权限范围：组/部门文档对该节点及子树用户可见；编辑需对应编辑授权。
        </div>
      </div>

      <!-- 上传进度提示 -->
      <div v-if="uploadDialog.progressText" class="upload-progress">
        <el-icon class="is-loading"><Loading /></el-icon>
        {{ uploadDialog.progressText }}
      </div>

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
          :disabled="!canSubmit"
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
.upload-section {
  margin-bottom: 16px;
}
.upload-section-label {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.upload-section-hint {
  font-weight: 400;
  color: #c0c4cc;
  font-size: 12px;
}
.collection-section {
  margin: 8px 0 16px;
  padding: 10px 12px;
  background: var(--lx-bg-subtle, #f5f7fa);
  border-radius: 6px;
}
.upload-progress {
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--lx-primary-50, #eef2ff);
  border-radius: 6px;
  color: var(--lx-primary-600, #4f46e5);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.owner-section {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed #ebeef5;
}
.owner-label {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.owner-radio-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.owner-tip {
  margin-top: 8px;
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
}
.doc-tag {
  margin-right: 4px;
  margin-bottom: 2px;
}
.muted {
  color: #c0c4cc;
}
.fav-star {
  cursor: pointer;
  font-size: 16px;
  color: #d1d5db;
  transition: color 0.15s;
}
.fav-star:hover {
  color: #f59e0b;
}
.fav-star.active {
  color: #f59e0b;
}
</style>

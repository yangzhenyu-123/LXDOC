<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import MarkdownEditor from '@/components/MarkdownEditor.vue';
import PdfViewer from '@/components/PdfViewer.vue';
import OnlyOfficeEditor from '@/components/OnlyOfficeEditor.vue';
import {
  getDocument,
  getPdfHtml,
  getKkViewUrl,
  convertToEditable,
  summarizeDocument,
  listVersions,
  rollback as rollbackApi,
  updateDocument,
  toggleFavorite as toggleFavoriteApi,
  type Document,
  type DocumentVersion,
} from '@/api/documents';
import {
  listAttachments,
  uploadAttachmentFile,
  deleteAttachment,
  getAttachmentKkViewUrl,
  type DocumentAttachment,
} from '@/api/attachments';
import {
  getFileToken,
  buildOriginalUrl,
  invalidateFileToken,
} from '@/api/files';
import { useAuthStore } from '@/stores/auth';
import { sanitizeHtml } from '@/utils/sanitize';
import { ATTACH_ACCEPT, isOnlyOfficeEditable } from '@/config/formats';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const docId = computed(() => String(route.params.docId ?? ''));

// 文档实体
const doc = ref<Document | null>(null);
// 收藏状态（从 doc.favorited 同步）
const favorited = ref(false);
const favoriteLoading = ref(false);
// 文件访问签名 token（加载文档时获取，供 PDF 原文件 / 编辑器图片加载使用）
const fileToken = ref('');
// 版本列表
const versions = ref<DocumentVersion[]>([]);
// 选中的版本号（用于回滚）
const selectedVersion = ref<number | null>(null);

// 加载 / 错误状态
const loading = ref(false);
const loadError = ref<string | null>(null);
// 保存中状态
const saving = ref(false);
// 回滚中状态
const rollbackLoading = ref(false);

// 当前编辑态：标题、内容、标签
const titleInput = ref('');
const contentInput = ref('');
const tagsInput = ref<string[]>([]);
// 新标签输入
const newTag = ref('');

// 最近一次保存的快照，用于检测是否有变更
const savedSnapshot = ref<{ title: string; content: string; tags: string[] }>({
  title: '',
  content: '',
  tags: [],
});

// 是否为可编辑文档格式（md/txt）
// docx/odt 走 OnlyOffice 编辑，无需"保存"按钮（OnlyOffice 自行保存）
// PDF 不提供前端编辑，其文本由 docling 在后端解析入库，仅供 LLM 搜索/总结
const isEditable = computed(() => {
  const f = doc.value?.format;
  return f === 'md' || f === 'txt';
});

// 是否为 PDF 格式
const isPdf = computed(() => doc.value?.format === 'pdf');

// 是否为 OnlyOffice 可编辑格式（word/cell/slide 全格式）
// 走 OnlyOffice 编辑/预览切换；md/txt 仍走 MarkdownEditor（Vditor 体验更好）
const isDocLike = computed(() => isOnlyOfficeEditable(doc.value?.format));

// OnlyOffice 模式：有写权限用 edit，否则 view
const onlyofficeMode = computed<'edit' | 'view'>(() =>
  authStore.canWrite ? 'edit' : 'view',
);

// PDF 预览 URL：走鉴权签名接口 /api/files/:docId/original?token=
const pdfUrl = computed(() =>
  doc.value && fileToken.value
    ? buildOriginalUrl(doc.value.id, fileToken.value)
    : '',
);

// PDF 两 tab：版式预览（kkFileView iframe） / 翻页预览（pdfjs）
// PDF 不提供"编辑文本"，文本由 docling 在后端解析入库供 LLM 使用
const pdfTab = ref<'layout' | 'pages'>('layout');
// kkFileView 预览 URL（iframe src）；为空且无错误时表示未加载/未启用
const kkviewUrl = ref('');
const kkviewLoading = ref(false);
const kkviewError = ref<string | null>(null);

// 转为可编辑文档（需写权限，editor/admin）
const convertLoading = ref(false);
const canConvert = computed(() => authStore.canWrite);

// AI 总结：读权限即可触发；基于文档已解析文本生成新 Markdown 总结文档（Docsify 渲染）
const summarizeLoading = ref(false);
// 当前文档是否本身是 AI 总结文档（用于显示"查看总结/阅读"入口）
const isAiSummary = computed(() => doc.value?.contentSource === 'ai_summary');

// docx/odt 模式切换：edit（编辑） / preview（预览）
const docMode = ref<'edit' | 'preview'>('edit');

// 两级全屏：
// 0 = 正常（侧栏 + 主区）
// 1 = 专注模式（隐藏侧栏，主区占满）
// 2 = 浏览器全屏（在 1 基础上调 Fullscreen API 占满屏幕）
const fullscreenLevel = ref<0 | 1 | 2>(0);
// 文档视图根元素引用，用于调用 requestFullscreen
const docViewRoot = ref<HTMLElement | null>(null);

async function toggleFullscreen() {
  const next = ((fullscreenLevel.value + 1) % 3) as 0 | 1 | 2;
  // 从浏览器全屏退出时，先退出 Fullscreen API
  if (fullscreenLevel.value === 2 && document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
  }
  // 进入浏览器全屏（level 2）
  if (next === 2) {
    try {
      await docViewRoot.value?.requestFullscreen();
      fullscreenLevel.value = 2;
    } catch {
      // 浏览器不支持或被拒绝，停留在专注模式
      fullscreenLevel.value = 1;
    }
  } else {
    fullscreenLevel.value = next;
  }
}

// 监听浏览器全屏状态变化（ESC 键退出全屏时同步级别）
function onFullscreenChange() {
  if (!document.fullscreenElement && fullscreenLevel.value === 2) {
    fullscreenLevel.value = 0;
  }
}

const fullscreenLabel = computed(() => {
  if (fullscreenLevel.value === 2) return '退出全屏';
  if (fullscreenLevel.value === 1) return '浏览器全屏';
  return '专注模式';
});

// 检测是否有未保存变更
function checkDirty(): boolean {
  if (!doc.value) return false;
  return (
    titleInput.value !== savedSnapshot.value.title ||
    contentInput.value !== savedSnapshot.value.content ||
    JSON.stringify(tagsInput.value.slice().sort()) !==
      JSON.stringify(savedSnapshot.value.tags.slice().sort())
  );
}

// 版本下拉显示文本
function versionLabel(v: DocumentVersion): string {
  return `v${v.version} · ${formatTime(v.createdAt)}`;
}

// 时间格式化
function formatTime(s: string | Date): string {
  if (!s) return '';
  const d = typeof s === 'string' ? new Date(s) : s;
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 加载文档详情
 */
async function loadDocument() {
  if (!docId.value) {
    loadError.value = '缺少文档 id';
    return;
  }
  loading.value = true;
  loadError.value = null;
  // 切换文档时失效旧 token 缓存，强制重新获取
  invalidateFileToken(docId.value);
  fileToken.value = '';
  try {
    const data = await getDocument(docId.value);
    doc.value = data;
    favorited.value = !!data.favorited;
    titleInput.value = data.title ?? '';
    contentInput.value = data.content ?? '';
    tagsInput.value = Array.isArray(data.tags) ? [...data.tags] : [];
    savedSnapshot.value = {
      title: data.title ?? '',
      content: data.content ?? '',
      tags: Array.isArray(data.tags) ? [...data.tags] : [],
    };
    selectedVersion.value = data.version;
    // 重置 docx/odt 模式状态
    docMode.value = 'edit';
    // 重置 PDF tab 状态
    pdfTab.value = 'layout';
    kkviewUrl.value = '';
    kkviewError.value = null;
    // 获取文件访问 token（PDF 原文件 / 编辑器图片加载需要）
    fileToken.value = await getFileToken(docId.value);
    await loadVersions();
    // 加载附件列表（含集合共享附件聚合）
    await loadAttachments();
    // PDF：首次加载即预载 kkFileView 版式预览 URL
    // watch(pdfTab) 无 immediate，初始值 'layout' 不触发，首屏会空白
    if (isPdf.value) {
      loadKkViewUrl();
    }
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '加载文档失败';
    loadError.value = msg;
  } finally {
    loading.value = false;
  }
}

/**
 * 加载版本列表
 */
async function loadVersions() {
  try {
    versions.value = (await listVersions(docId.value)) ?? [];
  } catch {
    // 版本加载失败不阻断主流程
    versions.value = [];
  }
}

/**
 * 添加新标签
 */
function addTag() {
  const t = newTag.value.trim();
  if (!t) return;
  if (tagsInput.value.includes(t)) {
    ElMessage.warning('该标签已存在');
    return;
  }
  tagsInput.value.push(t);
  newTag.value = '';
}

// 删除标签
function removeTag(t: string) {
  tagsInput.value = tagsInput.value.filter((x) => x !== t);
}

/**
 * 保存文档
 * - 若内容未变化，提示并跳过
 * - 调用 updateDocument，成功后刷新版本下拉
 * - PDF 模式下同样保存 title + content（全文入库后可编辑文本）
 */
async function save() {
  if (!doc.value) return;
  if (!checkDirty()) {
    ElMessage.info('内容未变化，无需保存');
    return;
  }
  saving.value = true;
  try {
    const updated = await updateDocument(docId.value, {
      title: titleInput.value,
      content: contentInput.value,
      tags: tagsInput.value,
    });
    doc.value = updated;
    titleInput.value = updated.title ?? '';
    contentInput.value = updated.content ?? '';
    tagsInput.value = Array.isArray(updated.tags) ? [...updated.tags] : [];
    savedSnapshot.value = {
      title: updated.title ?? '',
      content: updated.content ?? '',
      tags: Array.isArray(updated.tags) ? [...updated.tags] : [],
    };
    selectedVersion.value = updated.version;
    ElMessage.success('保存成功');
    await loadVersions();
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '保存失败';
    ElMessage.error(`保存失败：${msg}`);
  } finally {
    saving.value = false;
  }
}

/**
 * 加载 kkFileView 统一预览 URL（iframe 嵌入）
 * kkFileView 未启用时后端返回 503，前端回退 pdf2htmlEX 版式预览
 */
async function loadKkViewUrl() {
  if (!docId.value) return;
  kkviewLoading.value = true;
  kkviewError.value = null;
  try {
    kkviewUrl.value = await getKkViewUrl(docId.value);
  } catch (err: any) {
    // 503 表示 kkFileView 未启用，回退 pdf2htmlEX 版式预览
    if (err?.response?.status === 503) {
      kkviewUrl.value = '';
      await loadPdfHtmlFallback();
      return;
    }
    const msg =
      err?.response?.data?.message ?? err?.message ?? '预览加载失败';
    kkviewError.value = msg;
    kkviewUrl.value = '';
  } finally {
    kkviewLoading.value = false;
  }
}

/**
 * pdf2htmlEX 版式预览回退（kkFileView 未启用时）
 */
const pdfLayoutHtml = ref('');
const pdfLayoutLoading = ref(false);
async function loadPdfHtmlFallback() {
  pdfLayoutLoading.value = true;
  try {
    pdfLayoutHtml.value = await getPdfHtml(docId.value);
  } catch (e: any) {
    pdfLayoutHtml.value = '';
  } finally {
    pdfLayoutLoading.value = false;
  }
}

/**
 * 将 PDF 转为可编辑的新 markdown 文档
 * 成功后跳转到新文档
 */
async function onConvertToEditable() {
  if (!doc.value) return;
  try {
    await ElMessageBox.confirm(
      '将基于此 PDF 生成一份可编辑的 Markdown 文档（原 PDF 保留不动），是否继续？',
      '转为可编辑',
      { type: 'info', confirmButtonText: '转换', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  convertLoading.value = true;
  try {
    const newDoc = await convertToEditable(docId.value);
    ElMessage.success('已生成可编辑文档，正在跳转');
    router.push(`/d/${newDoc.id}`);
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '转换失败';
    ElMessage.error(`转换失败：${msg}`);
  } finally {
    convertLoading.value = false;
  }
}

/**
 * AI 总结：基于当前文档已解析的文本调用 GLM5.2 生成新 Markdown 总结文档
 * - 读权限即可触发
 * - 成功后跳转 Docsify 风格阅读视图（/read/:docId）展示总结
 * - LLM 未启用时后端返回 503，提示用户联系管理员
 */
async function onSummarize() {
  if (!doc.value) return;
  try {
    await ElMessageBox.confirm(
      '将调用 AI（GLM5.2）基于本文档生成一份结构化总结文档，生成后将跳转阅读视图。是否继续？',
      'AI 总结',
      { type: 'info', confirmButtonText: '生成总结', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  summarizeLoading.value = true;
  try {
    const newDoc = await summarizeDocument(docId.value);
    ElMessage.success('AI 总结生成完成，正在跳转阅读视图');
    router.push(`/read/${newDoc.id}`);
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? 'AI 总结失败';
    ElMessage.error(`AI 总结失败：${msg}`);
  } finally {
    summarizeLoading.value = false;
  }
}

/**
 * OnlyOffice 保存回调成功后：刷新文档元信息 + 版本下拉
 * 后端已 version+1 并写快照，前端只需重新拉取展示
 */
async function onOnlyOfficeSaved() {
  try {
    const data = await getDocument(docId.value);
    doc.value = data;
    selectedVersion.value = data.version;
    await loadVersions();
  } catch {
    // 刷新失败不阻断编辑，用户可手动刷新
  }
}

/**
 * 切换收藏状态（星标/取消星标）
 */
async function onToggleFavorite() {
  if (!doc.value) return;
  favoriteLoading.value = true;
  try {
    const next = await toggleFavoriteApi(docId.value);
    favorited.value = next;
    ElMessage.success(next ? '已收藏' : '已取消收藏');
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? '操作失败';
    ElMessage.error(msg);
  } finally {
    favoriteLoading.value = false;
  }
}

// docx/odt 模式切换：进入预览模式时懒加载 kkFileView URL（复用 PDF 的加载器）
watch(docMode, (mode) => {
  if (mode === 'preview' && !kkviewUrl.value && !kkviewError.value) {
    loadKkViewUrl();
  }
});

// PDF tab 切换：首次进入"版式预览"时懒加载 kkFileView URL
watch(pdfTab, (tab) => {
  if (
    tab === 'layout' &&
    !kkviewUrl.value &&
    !kkviewError.value &&
    !pdfLayoutHtml.value
  ) {
    loadKkViewUrl();
  }
});

/**
 * 回滚到选中版本
 */
async function rollback() {
  if (!doc.value) return;
  if (selectedVersion.value == null) {
    ElMessage.warning('请先选择要回滚的版本');
    return;
  }
  const targetVersion = selectedVersion.value;
  try {
    await ElMessageBox.confirm(
      `确认回滚到版本 v${targetVersion}？当前未保存内容将作为新版本保存。`,
      '回滚确认',
      {
        confirmButtonText: '确认回滚',
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
  } catch {
    // 用户取消
    return;
  }

  rollbackLoading.value = true;
  try {
    const updated = await rollbackApi(docId.value, targetVersion);
    doc.value = updated;
    titleInput.value = updated.title ?? '';
    contentInput.value = updated.content ?? '';
    tagsInput.value = Array.isArray(updated.tags) ? [...updated.tags] : [];
    savedSnapshot.value = {
      title: updated.title ?? '',
      content: updated.content ?? '',
      tags: Array.isArray(updated.tags) ? [...updated.tags] : [],
    };
    selectedVersion.value = updated.version;
    ElMessage.success('回滚成功');
    await loadVersions();
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '回滚失败';
    ElMessage.error(`回滚失败：${msg}`);
  } finally {
    rollbackLoading.value = false;
  }
}

// 返回上一页
function goBack() {
  router.back();
}

// ============ 附件管理 ============
// 附件列表（含集合共享附件聚合）
const attachments = ref<DocumentAttachment[]>([]);
const attachUploading = ref(false);
const attachLoading = ref(false);
// 附件预览抽屉
const attachPreviewVisible = ref(false);
const attachPreviewUrl = ref('');
const attachPreviewLoading = ref(false);

// 当前文档是否为集合主文档
const isCollection = computed(() => !!doc.value?.isCollection);
// 集合成员附件（attachType=document）
const collectionMembers = computed(() =>
  attachments.value.filter((a) => a.attachType === 'document'),
);
// 文件附件（attachType=file）
const fileAttachments = computed(() =>
  attachments.value.filter((a) => a.attachType === 'file'),
);
// 是否可管理附件（写权限）
const canManageAttachments = computed(() => authStore.canWrite);

/**
 * 加载附件列表
 */
async function loadAttachments() {
  if (!docId.value) return;
  attachLoading.value = true;
  try {
    attachments.value = await listAttachments(docId.value);
  } catch {
    attachments.value = [];
  } finally {
    attachLoading.value = false;
  }
}

/**
 * 上传附件文件
 */
async function onUploadAttachment(file: File) {
  if (!docId.value || !file) return;
  attachUploading.value = true;
  try {
    await uploadAttachmentFile(docId.value, file, fileAttachments.value.length + 1);
    ElMessage.success('附件上传成功');
    await loadAttachments();
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '附件上传失败';
    ElMessage.error(`附件上传失败：${msg}`);
  } finally {
    attachUploading.value = false;
  }
}

/**
 * 删除附件 / 移出集合
 */
async function removeAttachment(a: DocumentAttachment) {
  if (!docId.value) return;
  const tip =
    a.attachType === 'document'
      ? `确定把「${a.name}」移出文档集？被引用文档本身不会被删除。`
      : `确定删除附件「${a.name}」？文件将同时从磁盘移除。`;
  try {
    await ElMessageBox.confirm(tip, '确认', {
      type: 'warning',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    });
  } catch {
    return; // 用户取消
  }
  try {
    await deleteAttachment(docId.value, a.id);
    ElMessage.success(a.attachType === 'document' ? '已移出集合' : '附件已删除');
    await loadAttachments();
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '操作失败';
    ElMessage.error(`操作失败：${msg}`);
  }
}

/**
 * 预览附件（kkFileView iframe）
 */
async function previewAttachment(a: DocumentAttachment) {
  if (!docId.value) return;
  if (a.attachType === 'document') {
    // 集合成员：跳转到该文档
    if (a.linkedDocumentId) {
      router.push(`/document/${a.linkedDocumentId}`);
    }
    return;
  }
  attachPreviewLoading.value = true;
  attachPreviewVisible.value = true;
  attachPreviewUrl.value = '';
  try {
    const { url } = await getAttachmentKkViewUrl(docId.value, a.id);
    attachPreviewUrl.value = url;
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '预览加载失败';
    ElMessage.error(`附件预览失败：${msg}`);
    attachPreviewVisible.value = false;
  } finally {
    attachPreviewLoading.value = false;
  }
}

/**
 * 格式化文件大小
 */
function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

onMounted(() => {
  loadDocument();
  document.addEventListener('fullscreenchange', onFullscreenChange);
});

onUnmounted(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
});
</script>

<template>
  <div class="document-view" :class="{ 'fs-focus': fullscreenLevel >= 1 }" ref="docViewRoot">
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <el-button @click="goBack">
        <el-icon class="el-icon--left"><ArrowLeft /></el-icon>
        返回
      </el-button>
      <!-- 收藏/取消收藏 -->
      <el-button
        :loading="favoriteLoading"
        :type="favorited ? 'warning' : 'default'"
        :plain="favorited"
        @click="onToggleFavorite"
        :title="favorited ? '取消收藏' : '收藏'"
      >
        <el-icon class="el-icon--left">
          <StarFilled v-if="favorited" />
          <Star v-else />
        </el-icon>
        {{ favorited ? '已收藏' : '收藏' }}
      </el-button>
      <el-input
        v-model="titleInput"
        class="title-input"
        placeholder="文档标题"
        clearable
      />
      <!-- 保存（PDF 全文入库后亦可编辑文本，统一保存 title+content） -->
      <el-button
        type="primary"
        :loading="saving"
        :disabled="!isEditable"
        @click="save"
      >
        保存
      </el-button>
      <!-- PDF 转为可编辑文档（需写权限） -->
      <el-button
        v-if="isPdf && canConvert"
        :loading="convertLoading"
        @click="onConvertToEditable"
      >
        转为可编辑文档
      </el-button>
      <!-- AI 总结：基于已解析文本调用 GLM5.2 生成总结文档（读权限即可） -->
      <el-button
        :loading="summarizeLoading"
        @click="onSummarize"
      >
        AI 总结
      </el-button>
      <!-- 阅读视图：Docsify 风格渲染（Markdown 文档显示，AI 总结文档显示"查看原文"） -->
      <el-button
        v-if="doc && (doc.format === 'md' || isAiSummary)"
        @click="router.push(`/read/${docId}`)"
      >
        阅读视图
      </el-button>
      <el-select
        v-model="selectedVersion"
        placeholder="选择版本"
        class="version-select"
        :disabled="!versions.length"
      >
        <el-option
          v-for="v in versions"
          :key="v.id"
          :value="v.version"
          :label="versionLabel(v)"
        />
      </el-select>
      <el-button
        :loading="rollbackLoading"
        :disabled="selectedVersion == null"
        @click="rollback"
      >
        回滚到此版本
      </el-button>
      <!-- 两级全屏：1=专注模式（隐藏侧栏），2=浏览器原生全屏 -->
      <el-button
        class="fs-btn"
        :type="fullscreenLevel > 0 ? 'primary' : 'default'"
        @click="toggleFullscreen"
        :title="fullscreenLabel"
      >
        <el-icon class="el-icon--left">
          <FullScreen v-if="fullscreenLevel === 0" />
          <Expand v-else-if="fullscreenLevel === 1" />
          <Close v-else />
        </el-icon>
        {{ fullscreenLabel }}
      </el-button>
    </div>

    <!-- 主体区：loading / error / 内容 -->
    <div class="body">
      <div v-if="loading" class="loading-state" v-loading="true" />
      <div v-else-if="loadError" class="error-state">
        <el-alert
          :title="loadError"
          type="error"
          show-icon
          :closable="false"
        />
      </div>
      <div v-else-if="doc" class="content-wrapper">
        <!-- 左侧主区 -->
        <div class="main">
          <!-- PDF：版式预览 / 翻页预览 两 tab（文本由 docling 后端解析入库供 LLM） -->
          <template v-if="isPdf">
            <el-radio-group v-model="pdfTab" class="doc-mode-switch">
              <el-radio-button value="layout">版式预览</el-radio-button>
              <el-radio-button value="pages">翻页预览</el-radio-button>
            </el-radio-group>
            <!-- 版式预览：优先 kkFileView iframe；未启用时回退 pdf2htmlEX HTML -->
            <div
              v-if="pdfTab === 'layout'"
              class="preview-wrap"
              v-loading="kkviewLoading || pdfLayoutLoading"
            >
              <el-alert
                v-if="kkviewError"
                :title="kkviewError"
                type="error"
                show-icon
                :closable="false"
              />
              <iframe
                v-else-if="kkviewUrl"
                :src="kkviewUrl"
                class="kkview-iframe"
                frameborder="0"
                allowfullscreen
              />
              <div
                v-else-if="pdfLayoutHtml"
                class="preview-html pdf-layout-html"
                v-html="sanitizeHtml(pdfLayoutHtml)"
              />
            </div>
            <!-- 翻页预览：pdfjs canvas 渲染原文件 -->
            <PdfViewer
              v-else-if="pdfTab === 'pages'"
              :src="pdfUrl"
            />
          </template>
          <!-- docx/odt：OnlyOffice 编辑 / kkFileView 预览 切换 -->
          <template v-else-if="isDocLike">
            <el-radio-group v-model="docMode" class="doc-mode-switch">
              <el-radio-button value="edit">{{ onlyofficeMode === 'edit' ? '编辑' : '查看' }}</el-radio-button>
              <el-radio-button value="preview">预览</el-radio-button>
            </el-radio-group>
            <OnlyOfficeEditor
              v-if="docMode === 'edit'"
              :doc-id="docId"
              :mode="onlyofficeMode"
              @saved="onOnlyOfficeSaved"
            />
            <div v-else class="preview-wrap" v-loading="kkviewLoading">
              <el-alert
                v-if="kkviewError"
                :title="kkviewError"
                type="error"
                show-icon
                :closable="false"
              />
              <iframe
                v-else-if="kkviewUrl"
                :src="kkviewUrl"
                class="kkview-iframe"
                frameborder="0"
                allowfullscreen
              />
            </div>
          </template>
          <!-- md/txt：直接编辑 -->
          <MarkdownEditor
            v-else-if="isEditable"
            v-model="contentInput"
            :doc-id="docId"
            :file-token="fileToken"
            @save="save"
          />
          <el-empty v-else :description="`暂不支持的格式：${doc.format}`" />
        </div>

        <!-- 右侧侧栏（专注模式/浏览器全屏时隐藏） -->
        <el-aside v-show="fullscreenLevel === 0" width="280px" class="sidebar">
          <!-- 元信息卡片 -->
          <el-card class="meta-card" shadow="never">
            <template #header>
              <span class="card-title">元信息</span>
            </template>
            <ul class="meta-list">
              <li><span class="meta-key">作者</span><span class="meta-val">{{ doc.author || '-' }}</span></li>
              <li><span class="meta-key">当前版本</span><span class="meta-val">v{{ doc.version }}</span></li>
              <li><span class="meta-key">格式</span><span class="meta-val">{{ doc.format }}</span></li>
              <li v-if="isAiSummary">
                <span class="meta-key">来源</span>
                <span class="meta-val">
                  <el-button
                    link
                    type="primary"
                    @click="router.push(`/d/${doc.sourceDocId}`)"
                  >
                    查看原文档
                  </el-button>
                </span>
              </li>
              <li><span class="meta-key">创建时间</span><span class="meta-val">{{ formatTime(doc.createdAt) }}</span></li>
              <li><span class="meta-key">最后修改</span><span class="meta-val">{{ formatTime(doc.updatedAt) }}</span></li>
            </ul>
          </el-card>

          <!-- 标签编辑 -->
          <el-card class="meta-card" shadow="never">
            <template #header>
              <span class="card-title">标签</span>
            </template>
            <div class="tags-box">
              <el-tag
                v-for="t in tagsInput"
                :key="t"
                class="tag-item"
                closable
                @close="removeTag(t)"
              >
                {{ t }}
              </el-tag>
            </div>
            <el-input
              v-model="newTag"
              placeholder="输入标签后回车添加"
              class="tag-input"
              @keyup.enter="addTag"
            />
          </el-card>

          <!-- 版本历史 -->
          <el-card class="meta-card" shadow="never">
            <template #header>
              <span class="card-title">版本历史</span>
            </template>
            <el-select
              v-model="selectedVersion"
              placeholder="选择版本"
              class="version-select-full"
              :disabled="!versions.length"
            >
              <el-option
                v-for="v in versions"
                :key="v.id"
                :value="v.version"
                :label="versionLabel(v)"
              />
            </el-select>
            <el-button
              class="rollback-btn"
              :loading="rollbackLoading"
              :disabled="selectedVersion == null"
              @click="rollback"
            >
              回滚到此版本
            </el-button>
          </el-card>

          <!-- 文档集成员（仅集合主文档显示） -->
          <el-card v-if="isCollection" class="meta-card" shadow="never">
            <template #header>
              <span class="card-title">文档集成员（{{ collectionMembers.length }}）</span>
            </template>
            <div v-if="attachLoading" class="attach-empty">加载中...</div>
            <div v-else-if="!collectionMembers.length" class="attach-empty">
              暂无成员文档
            </div>
            <ul v-else class="member-list">
              <li v-for="m in collectionMembers" :key="m.id" class="member-item">
                <el-link
                  type="primary"
                  :underline="false"
                  @click="m.linkedDocumentId && router.push(`/document/${m.linkedDocumentId}`)"
                >
                  {{ m.name }}
                </el-link>
                <el-button
                  v-if="canManageAttachments"
                  link
                  size="small"
                  type="danger"
                  @click="removeAttachment(m)"
                >
                  移出
                </el-button>
              </li>
            </ul>
          </el-card>

          <!-- 附件文件 -->
          <el-card class="meta-card" shadow="never">
            <template #header>
              <span class="card-title">附件（{{ fileAttachments.length }}）</span>
            </template>
            <!-- 上传附件按钮（写权限） -->
            <el-upload
              v-if="canManageAttachments"
              :show-file-list="false"
              :auto-upload="true"
              :before-upload="onUploadAttachment"
              :disabled="attachUploading"
              :accept="ATTACH_ACCEPT"
              class="attach-upload"
            >
              <el-button :loading="attachUploading" size="small" class="attach-add-btn">
                + 添加附件
              </el-button>
            </el-upload>
            <div v-if="attachLoading" class="attach-empty">加载中...</div>
            <div v-else-if="!fileAttachments.length" class="attach-empty">
              暂无附件
            </div>
            <ul v-else class="attach-list">
              <li v-for="a in fileAttachments" :key="a.id" class="attach-item">
                <div class="attach-info" @click="previewAttachment(a)">
                  <span class="attach-name" :title="a.name">{{ a.name }}</span>
                  <span class="attach-size">{{ formatSize(a.fileSize) }}</span>
                </div>
                <el-button
                  v-if="canManageAttachments"
                  link
                  size="small"
                  type="danger"
                  @click="removeAttachment(a)"
                >
                  删除
                </el-button>
              </li>
            </ul>
          </el-card>
        </el-aside>
      </div>
    </div>

    <!-- 附件预览抽屉（kkFileView iframe） -->
    <el-drawer
      v-model="attachPreviewVisible"
      title="附件预览"
      size="80%"
      direction="rtl"
      :destroy-on-close="true"
    >
      <div v-if="attachPreviewLoading" class="preview-loading">加载中...</div>
      <iframe
        v-else-if="attachPreviewUrl"
        :src="attachPreviewUrl"
        class="preview-iframe"
        frameborder="0"
        allowfullscreen
      />
    </el-drawer>
  </div>
</template>

<style scoped>
.document-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f5f7fa;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
}
.title-input {
  flex: 1;
  max-width: 480px;
}
.version-select {
  width: 220px;
}
.body {
  flex: 1;
  overflow: hidden;
  padding: 16px;
}
.loading-state,
.error-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.content-wrapper {
  display: flex;
  gap: 16px;
  height: 100%;
}
.main {
  flex: 1;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  padding: 12px;
  overflow: auto;
  display: flex;
  flex-direction: column;
}
.doc-mode-switch {
  margin-bottom: 12px;
  align-self: flex-start;
}
.preview-wrap {
  flex: 1;
  overflow: auto;
  padding: 8px;
}
.preview-html {
  font-size: 14px;
  line-height: 1.7;
  color: #303133;
}
.preview-html :deep(img) {
  max-width: 100%;
  height: auto;
}
.preview-html :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
}
.preview-html :deep(th),
.preview-html :deep(td) {
  border: 1px solid #dcdfe6;
  padding: 6px 10px;
  text-align: left;
}
.preview-html :deep(pre) {
  background: #f5f7fa;
  padding: 10px;
  border-radius: 4px;
  overflow: auto;
}
.preview-html :deep(code) {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
}
/* kkFileView iframe 撑满预览区域 */
.kkview-iframe {
  width: 100%;
  height: 100%;
  min-height: 70vh;
  border: none;
}
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
}
.meta-card {
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  /* 不被 flex 容器压缩，内容自然撑开，避免卡片内部出现滚动条 */
  flex-shrink: 0;
}
.meta-card :deep(.el-card__body) {
  overflow: visible;
}
.card-title {
  font-weight: 600;
}
.meta-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.meta-list li {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 13px;
  border-bottom: 1px dashed #ebeef5;
}
.meta-list li:last-child {
  border-bottom: none;
}
.meta-key {
  color: #909399;
}
.meta-val {
  color: #303133;
  text-align: right;
  max-width: 60%;
  word-break: break-all;
}
.tags-box {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  min-height: 24px;
}
.tag-item {
  margin: 0;
}
.tag-input {
  width: 100%;
}
.version-select-full {
  width: 100%;
  margin-bottom: 8px;
}
.rollback-btn {
  width: 100%;
}
.fs-btn {
  margin-left: auto;
}
/* 专注模式/浏览器全屏：收紧 body padding，主区更宽敞 */
.document-view.fs-focus .body {
  padding: 8px;
}
.attach-upload {
  margin-bottom: 8px;
}
/* 添加附件按钮：渐变红色主题，白字始终清晰，避免 plain 样式文字过淡 */
.attach-add-btn {
  background: var(--lx-gradient-danger);
  border: none;
  color: var(--lx-text-inverse);
  font-weight: var(--lx-font-medium);
  box-shadow: 0 2px 6px rgba(239, 68, 68, 0.3);
  transition: background var(--lx-transition), box-shadow var(--lx-transition);
}
.attach-add-btn:hover,
.attach-add-btn:focus {
  background: var(--lx-gradient-danger-hover);
  color: var(--lx-text-inverse);
  border: none;
  box-shadow: 0 4px 10px rgba(239, 68, 68, 0.4);
}
.attach-add-btn:active {
  background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%);
  color: var(--lx-text-inverse);
}
.attach-add-btn.is-disabled,
.attach-add-btn.is-loading {
  opacity: 0.6;
  cursor: not-allowed;
}
.attach-empty {
  color: #c0c4cc;
  font-size: 12px;
  text-align: center;
  padding: 8px 0;
}
.attach-list,
.member-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.attach-item,
.member-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed #ebeef5;
}
.attach-item:last-child,
.member-item:last-child {
  border-bottom: none;
}
.attach-info {
  flex: 1;
  min-width: 0;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.attach-info:hover .attach-name {
  color: var(--lx-primary-600, #4f46e5);
}
.attach-name {
  font-size: 13px;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.attach-size {
  font-size: 11px;
  color: #c0c4cc;
}
.preview-loading {
  text-align: center;
  padding: 40px;
  color: #909399;
}
.preview-iframe {
  width: 100%;
  height: calc(100vh - 100px);
  border: none;
}
</style>

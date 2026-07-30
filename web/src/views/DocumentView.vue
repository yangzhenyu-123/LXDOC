<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import MarkdownEditor from '@/components/MarkdownEditor.vue';
import PdfViewer from '@/components/PdfViewer.vue';
import OnlyOfficeEditor from '@/components/OnlyOfficeEditor.vue';
import {
  getDocument,
  getPreviewHtml,
  getPdfHtml,
  convertToEditable,
  summarizeDocument,
  listVersions,
  rollback as rollbackApi,
  updateDocument,
  type Document,
  type DocumentVersion,
} from '@/api/documents';
import {
  getFileToken,
  buildOriginalUrl,
  invalidateFileToken,
} from '@/api/files';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const docId = computed(() => String(route.params.docId ?? ''));

// 文档实体
const doc = ref<Document | null>(null);
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

// 是否为可编辑文档格式（md/txt/docx/odt/pdf，PDF 全文入库后亦可编辑文本）
// docx/odt 走 OnlyOffice，无需"保存"按钮（OnlyOffice 自行保存）
const isEditable = computed(() => {
  const f = doc.value?.format;
  return f === 'md' || f === 'txt' || f === 'pdf';
});

// 是否为 PDF 格式
const isPdf = computed(() => doc.value?.format === 'pdf');

// 是否为 docx/odt（走 OnlyOffice 编辑/查看）
const isDocLike = computed(() => {
  const f = doc.value?.format;
  return f === 'docx' || f === 'odt';
});

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

// PDF 三 tab：版式预览（pdf2htmlEX） / 翻页预览（pdfjs） / 编辑文本（Vditor）
const pdfTab = ref<'layout' | 'pages' | 'text'>('layout');
const pdfLayoutHtml = ref('');
const pdfLayoutLoading = ref(false);
const pdfLayoutError = ref<string | null>(null);

// 转为可编辑文档（需写权限，editor/admin）
const convertLoading = ref(false);
const canConvert = computed(() => authStore.canWrite);

// AI 总结：读权限即可触发；基于文档已解析文本生成新 Markdown 总结文档（Docsify 渲染）
const summarizeLoading = ref(false);
// 当前文档是否本身是 AI 总结文档（用于显示"查看总结/阅读"入口）
const isAiSummary = computed(() => doc.value?.contentSource === 'ai_summary');

// docx/odt 模式切换：edit（编辑） / preview（原版预览）
const docMode = ref<'edit' | 'preview'>('edit');
// 原版预览 HTML
const previewHtml = ref('');
const previewLoading = ref(false);
const previewError = ref<string | null>(null);

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
    titleInput.value = data.title ?? '';
    contentInput.value = data.content ?? '';
    tagsInput.value = Array.isArray(data.tags) ? [...data.tags] : [];
    savedSnapshot.value = {
      title: data.title ?? '',
      content: data.content ?? '',
      tags: Array.isArray(data.tags) ? [...data.tags] : [],
    };
    selectedVersion.value = data.version;
    // 重置 docx/odt 预览状态
    docMode.value = 'edit';
    previewHtml.value = '';
    previewError.value = null;
    // 重置 PDF tab 状态
    pdfTab.value = 'layout';
    pdfLayoutHtml.value = '';
    pdfLayoutError.value = null;
    // 获取文件访问 token（PDF 原文件 / 编辑器图片加载需要）
    fileToken.value = await getFileToken(docId.value);
    await loadVersions();
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
 * 加载 PDF 版式保真 HTML（pdf2htmlEX 生成）
 */
async function loadPdfLayoutHtml() {
  if (!docId.value) return;
  pdfLayoutLoading.value = true;
  pdfLayoutError.value = null;
  try {
    pdfLayoutHtml.value = await getPdfHtml(docId.value);
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '版式预览加载失败';
    pdfLayoutError.value = msg;
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
 * 加载 docx/odt 原版预览 HTML
 */
async function loadPreviewHtml() {
  if (!docId.value) return;
  previewLoading.value = true;
  previewError.value = null;
  try {
    previewHtml.value = await getPreviewHtml(docId.value);
  } catch (err: any) {
    const msg =
      err?.response?.data?.message ?? err?.message ?? '加载预览失败';
    previewError.value = msg;
    previewHtml.value = '';
  } finally {
    previewLoading.value = false;
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

// docx/odt 模式切换：进入预览模式时拉取 HTML
watch(docMode, (mode) => {
  if (mode === 'preview' && !previewHtml.value && !previewError.value) {
    loadPreviewHtml();
  }
});

// PDF tab 切换：首次进入"版式预览"时懒加载 pdf2htmlEX HTML
watch(pdfTab, (tab) => {
  if (tab === 'layout' && !pdfLayoutHtml.value && !pdfLayoutError.value) {
    loadPdfLayoutHtml();
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

onMounted(() => {
  loadDocument();
});
</script>

<template>
  <div class="document-view">
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <el-button @click="goBack">
        <el-icon class="el-icon--left"><ArrowLeft /></el-icon>
        返回
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
          <!-- PDF：版式预览 / 翻页预览 / 编辑文本 三 tab -->
          <template v-if="isPdf">
            <el-radio-group v-model="pdfTab" class="doc-mode-switch">
              <el-radio-button value="layout">版式预览</el-radio-button>
              <el-radio-button value="pages">翻页预览</el-radio-button>
              <el-radio-button value="text">编辑文本</el-radio-button>
            </el-radio-group>
            <!-- 版式预览：pdf2htmlEX 生成的保真 HTML -->
            <div
              v-if="pdfTab === 'layout'"
              class="preview-wrap"
              v-loading="pdfLayoutLoading"
            >
              <el-alert
                v-if="pdfLayoutError"
                :title="pdfLayoutError"
                type="error"
                show-icon
                :closable="false"
              />
              <div
                v-else
                class="preview-html pdf-layout-html"
                v-html="pdfLayoutHtml"
              />
            </div>
            <!-- 翻页预览：pdfjs canvas 渲染原文件 -->
            <PdfViewer
              v-else-if="pdfTab === 'pages'"
              :src="pdfUrl"
            />
            <!-- 编辑文本：编辑 pdf-parse 提取的全文 -->
            <MarkdownEditor
              v-else
              v-model="contentInput"
              :doc-id="docId"
              :file-token="fileToken"
              @save="save"
            />
          </template>
          <!-- docx/odt：OnlyOffice 真编辑 / pandoc 原版预览 切换 -->
          <template v-else-if="isDocLike">
            <el-radio-group v-model="docMode" class="doc-mode-switch">
              <el-radio-button value="edit">{{ onlyofficeMode === 'edit' ? '编辑' : '查看' }}</el-radio-button>
              <el-radio-button value="preview">原版预览</el-radio-button>
            </el-radio-group>
            <OnlyOfficeEditor
              v-if="docMode === 'edit'"
              :doc-id="docId"
              :mode="onlyofficeMode"
              @saved="onOnlyOfficeSaved"
            />
            <div v-else class="preview-wrap" v-loading="previewLoading">
              <el-alert
                v-if="previewError"
                :title="previewError"
                type="error"
                show-icon
                :closable="false"
              />
              <div
                v-else
                class="preview-html"
                v-html="previewHtml"
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

        <!-- 右侧侧栏 -->
        <el-aside width="280px" class="sidebar">
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
        </el-aside>
      </div>
    </div>
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
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
}
.meta-card {
  border: 1px solid #e4e7ed;
  border-radius: 4px;
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
</style>

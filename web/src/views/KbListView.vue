<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  ElMessage,
  ElMessageBox,
  type FormInstance,
  type FormRules,
} from 'element-plus';
import {
  Plus,
  ChatLineRound,
  Document as DocIcon,
  Edit,
  Delete,
  Management,
  CircleClose,
} from '@element-plus/icons-vue';
import {
  listKbs,
  getKbStats,
  createKb,
  updateKb,
  deleteKb,
  listKbDocuments,
  addDocumentToKb,
  removeDocumentFromKb,
  type KnowledgeBase,
  type KbStats,
  type KbDocument,
} from '@/api/kb';
import { useAuthStore } from '@/stores/auth';

/**
 * 知识库列表 + 管理页
 *
 * - 所有登录用户：查看 KB 列表 + 进入问答
 * - admin：创建/编辑/删除 KB + 管理文档（加入/移出）
 */

const router = useRouter();
const authStore = useAuthStore();

const kbs = ref<KnowledgeBase[]>([]);
const statsMap = ref<Record<string, KbStats>>({});
const loading = ref(false);

// ============ 创建/编辑对话框 ============

const dialogVisible = ref(false);
const dialogMode = ref<'create' | 'edit'>('create');
const editingId = ref<string | null>(null);
const formRef = ref<FormInstance>();
const form = reactive({
  name: '',
  description: '',
});
const submitting = ref(false);

const rules: FormRules = {
  name: [
    { required: true, message: '请输入知识库名称', trigger: 'blur' },
    { max: 200, message: '名称不超过 200 字符', trigger: 'blur' },
  ],
  description: [{ max: 2000, message: '描述不超过 2000 字符', trigger: 'blur' }],
};

// ============ 文档管理抽屉 ============

const docDrawerVisible = ref(false);
const docDrawerKb = ref<KnowledgeBase | null>(null);
const kbDocs = ref<KbDocument[]>([]);
const docsLoading = ref(false);
const addDocId = ref('');
const addSubmitting = ref(false);

// ============ 加载 ============

async function load() {
  loading.value = true;
  try {
    kbs.value = await listKbs();
    // 并发拉每个 KB 的统计（不阻塞列表展示，失败静默）
    kbs.value.forEach(async (kb) => {
      try {
        const stats = await getKbStats(kb.id);
        statsMap.value[kb.id] = stats;
      } catch {
        // 静默：统计加载失败不阻塞列表
      }
    });
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '加载知识库列表失败');
  } finally {
    loading.value = false;
  }
}

// ============ 创建/编辑 ============

function openCreate() {
  dialogMode.value = 'create';
  editingId.value = null;
  form.name = '';
  form.description = '';
  dialogVisible.value = true;
}

function openEdit(kb: KnowledgeBase) {
  dialogMode.value = 'edit';
  editingId.value = kb.id;
  form.name = kb.name;
  form.description = kb.description ?? '';
  dialogVisible.value = true;
}

async function submitForm() {
  if (!formRef.value) return;
  await formRef.value.validate(async (valid) => {
    if (!valid) return;
    submitting.value = true;
    try {
      if (dialogMode.value === 'create') {
        await createKb({
          name: form.name,
          description: form.description || undefined,
        });
        ElMessage.success('知识库创建成功');
      } else if (editingId.value) {
        await updateKb(editingId.value, {
          name: form.name,
          description: form.description || undefined,
        });
        ElMessage.success('已更新');
      }
      dialogVisible.value = false;
      await load();
    } catch (err: any) {
      ElMessage.error(err?.response?.data?.message ?? '操作失败');
    } finally {
      submitting.value = false;
    }
  });
}

async function confirmDelete(kb: KnowledgeBase) {
  try {
    await ElMessageBox.confirm(
      `确认删除知识库「${kb.name}」？该操作会移除其下所有 chunk 与 embedding，且不可恢复。`,
      '危险操作',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await deleteKb(kb.id);
    ElMessage.success('已删除');
    await load();
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '删除失败');
  }
}

// ============ 文档管理 ============

async function openDocDrawer(kb: KnowledgeBase) {
  docDrawerKb.value = kb;
  docDrawerVisible.value = true;
  await loadKbDocs(kb.id);
}

async function loadKbDocs(kbId: string) {
  docsLoading.value = true;
  try {
    kbDocs.value = await listKbDocuments(kbId);
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '加载文档列表失败');
    kbDocs.value = [];
  } finally {
    docsLoading.value = false;
  }
}

async function addDoc() {
  if (!docDrawerKb.value || !addDocId.value.trim()) return;
  addSubmitting.value = true;
  try {
    const { chunkCount } = await addDocumentToKb(
      docDrawerKb.value.id,
      addDocId.value.trim(),
    );
    ElMessage.success(`文档已加入，生成 ${chunkCount} 个 chunk`);
    addDocId.value = '';
    await loadKbDocs(docDrawerKb.value.id);
    // 刷新 KB 列表统计
    await load();
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '加入失败，请确认文档 ID 正确');
  } finally {
    addSubmitting.value = false;
  }
}

async function removeDoc(doc: KbDocument) {
  if (!docDrawerKb.value) return;
  try {
    await ElMessageBox.confirm(
      `从知识库移除「${doc.title}」？该文档的所有 chunk 与 embedding 将被删除。`,
      '提示',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await removeDocumentFromKb(docDrawerKb.value.id, doc.documentId);
    ElMessage.success('已移除');
    await loadKbDocs(docDrawerKb.value.id);
    await load();
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '移除失败');
  }
}

// ============ 进入问答 ============

function goAsk(kb: KnowledgeBase) {
  router.push(`/kb/${kb.id}`);
}

// ============ 计算 ============

const isAdmin = computed(() => authStore.isAdmin);

function formatTime(s: string | Date): string {
  if (!s) return '';
  const d = typeof s === 'string' ? new Date(s) : s;
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString('zh-CN', { hour12: false });
}

onMounted(load);
</script>

<template>
  <div class="kb-list-view" v-loading="loading">
    <!-- 顶部栏 -->
    <header class="page-header">
      <div class="header-left">
        <h1>RAG 知识库</h1>
        <p class="subtitle">
          基于 pgvector 向量检索 + GLM 流式生成的智能问答。选择知识库开始提问。
        </p>
      </div>
      <div class="header-actions" v-if="isAdmin">
        <el-button type="primary" :icon="Plus" @click="openCreate">
          新建知识库
        </el-button>
      </div>
    </header>

    <!-- KB 卡片网格 -->
    <div class="kb-grid">
      <div v-for="kb in kbs" :key="kb.id" class="kb-card">
        <div class="card-header">
          <el-icon class="card-icon"><ChatLineRound /></el-icon>
          <div class="card-title-block">
            <div class="card-title" :title="kb.name">{{ kb.name }}</div>
            <div class="card-model" v-if="kb.embeddingModel">
              {{ kb.embeddingModel }} · {{ kb.embeddingDimensions }} 维
            </div>
          </div>
        </div>

        <div class="card-desc" v-if="kb.description">{{ kb.description }}</div>
        <div class="card-desc empty" v-else>暂无描述</div>

        <div class="card-stats">
          <div class="stat">
            <span class="stat-num">{{ statsMap[kb.id]?.documentCount ?? kb.documentCount }}</span>
            <span class="stat-label">文档</span>
          </div>
          <div class="stat">
            <span class="stat-num">{{ statsMap[kb.id]?.chunkCount ?? kb.chunkCount }}</span>
            <span class="stat-label">chunks</span>
          </div>
          <div class="stat">
            <span class="stat-num">{{ statsMap[kb.id]?.embeddedCount ?? '—' }}</span>
            <span class="stat-label">已嵌入</span>
          </div>
        </div>

        <div class="card-footer">
          <span class="time">{{ formatTime(kb.updatedAt) }}</span>
          <div class="footer-actions">
            <el-button type="primary" size="small" :icon="ChatLineRound" @click="goAsk(kb)">
              进入问答
            </el-button>
            <el-button v-if="isAdmin" size="small" :icon="Management" @click="openDocDrawer(kb)">
              管理文档
            </el-button>
            <el-button v-if="isAdmin" size="small" :icon="Edit" @click="openEdit(kb)" />
            <el-button v-if="isAdmin" size="small" type="danger" :icon="Delete" @click="confirmDelete(kb)" />
          </div>
        </div>
      </div>

      <el-empty v-if="!loading && kbs.length === 0" description="暂无知识库" />
    </div>

    <!-- 创建/编辑对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogMode === 'create' ? '新建知识库' : '编辑知识库'"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
      >
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="如：产品技术文档库" clearable />
        </el-form-item>
        <el-form-item label="描述" prop="description">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="3"
            placeholder="知识库用途说明（可选）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ dialogMode === 'create' ? '创建' : '保存' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 文档管理抽屉 -->
    <el-drawer
      v-model="docDrawerVisible"
      :title="`管理文档 - ${docDrawerKb?.name ?? ''}`"
      size="520px"
      direction="rtl"
    >
      <div class="drawer-content">
        <!-- 加入文档 -->
        <div class="drawer-section" v-if="isAdmin">
          <div class="section-title">
            <el-icon><Plus /></el-icon>
            <span>加入文档</span>
          </div>
          <div class="add-row">
            <el-input
              v-model="addDocId"
              placeholder="输入文档 UUID"
              clearable
              :disabled="addSubmitting"
              @keyup.enter="addDoc"
            />
            <el-button type="primary" :loading="addSubmitting" @click="addDoc">加入</el-button>
          </div>
          <div class="hint">提示：可从文档详情页 URL 获取 UUID（/d/<文档ID>）</div>
        </div>

        <!-- 当前文档列表 -->
        <div class="drawer-section">
          <div class="section-title">
            <el-icon><DocIcon /></el-icon>
            <span>当前文档（{{ kbDocs.length }}）</span>
          </div>
          <div class="doc-list" v-loading="docsLoading">
            <div v-for="doc in kbDocs" :key="doc.documentId" class="doc-item">
              <div class="doc-info">
                <div class="doc-title" :title="doc.title">
                  <el-icon><DocIcon /></el-icon>
                  {{ doc.title }}
                </div>
                <div class="doc-meta">
                  <el-tag size="small" type="info">{{ doc.format }}</el-tag>
                  <span class="doc-chunks">{{ doc.chunkCount }} chunks</span>
                </div>
              </div>
              <el-button
                v-if="isAdmin"
                size="small"
                type="danger"
                :icon="CircleClose"
                circle
                @click="removeDoc(doc)"
              />
            </div>
            <el-empty v-if="!docsLoading && kbDocs.length === 0" :image-size="60" description="暂无文档" />
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.kb-list-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: auto;
  background: var(--lx-bg);
  padding: var(--lx-space-5);
  gap: var(--lx-space-4);
}

/* 顶部 */
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--lx-space-4);
}
.page-header h1 {
  margin: 0 0 var(--lx-space-2);
  font-size: var(--lx-font-2xl);
  color: var(--lx-text);
}
.subtitle {
  margin: 0;
  color: var(--lx-text-secondary);
  font-size: var(--lx-font-sm);
}

/* 卡片网格 */
.kb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--lx-space-4);
}
.kb-card {
  background: var(--lx-bg-elevated);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-lg);
  padding: var(--lx-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--lx-space-3);
  box-shadow: var(--lx-shadow-sm);
  transition: all var(--lx-transition);
}
.kb-card:hover {
  border-color: var(--lx-primary);
  box-shadow: var(--lx-shadow-md);
  transform: translateY(-2px);
}
.card-header {
  display: flex;
  align-items: center;
  gap: var(--lx-space-3);
}
.card-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--lx-radius-md);
  background: var(--lx-gradient-primary);
  color: var(--lx-text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  flex-shrink: 0;
}
.card-title-block {
  flex: 1;
  min-width: 0;
}
.card-title {
  font-size: var(--lx-font-md);
  font-weight: var(--lx-font-semibold);
  color: var(--lx-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-model {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
  margin-top: 2px;
}
.card-desc {
  font-size: var(--lx-font-sm);
  color: var(--lx-text-regular);
  line-height: 1.5;
  min-height: 2.1em;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-desc.empty {
  color: var(--lx-text-placeholder);
  font-style: italic;
}
.card-stats {
  display: flex;
  gap: var(--lx-space-4);
  padding: var(--lx-space-3) 0;
  border-top: 1px solid var(--lx-border);
  border-bottom: 1px solid var(--lx-border);
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
}
.stat-num {
  font-size: var(--lx-font-xl);
  font-weight: var(--lx-font-bold);
  color: var(--lx-primary);
}
.stat-label {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
  margin-top: 2px;
}
.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lx-space-2);
}
.time {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
}
.footer-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

/* 抽屉 */
.drawer-content {
  display: flex;
  flex-direction: column;
  gap: var(--lx-space-5);
  padding: 0 var(--lx-space-2);
}
.drawer-section {
  display: flex;
  flex-direction: column;
  gap: var(--lx-space-2);
}
.section-title {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  font-size: var(--lx-font-md);
  font-weight: var(--lx-font-semibold);
  color: var(--lx-text);
}
.section-title .el-icon {
  color: var(--lx-primary);
}
.add-row {
  display: flex;
  gap: var(--lx-space-2);
}
.hint {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
}
.doc-list {
  display: flex;
  flex-direction: column;
  gap: var(--lx-space-2);
  max-height: 480px;
  overflow-y: auto;
}
.doc-item {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  padding: var(--lx-space-2) var(--lx-space-3);
  background: var(--lx-bg-subtle);
  border-radius: var(--lx-radius-sm);
  border: 1px solid var(--lx-border-light);
}
.doc-info {
  flex: 1;
  min-width: 0;
}
.doc-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--lx-font-sm);
  color: var(--lx-text);
  font-weight: var(--lx-font-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc-title .el-icon {
  color: var(--lx-text-placeholder);
  flex-shrink: 0;
}
.doc-meta {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  margin-top: 4px;
}
.doc-chunks {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
}
</style>

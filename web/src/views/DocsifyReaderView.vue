<template>
  <div class="docsify-reader">
    <!-- 顶部工具条：返回 / 查看原文 / 编辑 -->
    <header class="reader-bar">
      <el-button text :icon="ArrowLeft" @click="goBack">返回</el-button>
      <span class="reader-title" :title="doc?.title ?? ''">
        {{ doc?.title ?? '加载中…' }}
      </span>
      <div class="reader-actions">
        <el-tag v-if="doc?.sourceDocId" type="success" size="small">
          AI 总结
        </el-tag>
        <el-button
          v-if="doc?.sourceDocId"
          text
          :icon="Document"
          @click="viewSource"
        >
          查看原文
        </el-button>
        <el-button
          v-if="doc && canEdit"
          text
          :icon="Edit"
          @click="goEdit"
        >
          编辑
        </el-button>
      </div>
    </header>

    <main class="reader-main">
      <div v-if="loading" v-loading="true" class="reader-loading" />
      <el-alert
        v-else-if="error"
        :title="error"
        type="error"
        show-icon
        :closable="false"
      />
      <!-- Docsify 风格渲染容器：marked 渲染 Markdown + docsify 主题样式 -->
      <article
        v-else
        ref="articleRef"
        class="markdown-body docsify-theme"
        v-html="renderedHtml"
      />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowLeft, Document, Edit } from '@element-plus/icons-vue';
import { marked } from 'marked';
import { getDocument, type Document as Doc } from '@/api/documents';
import { useAuthStore } from '@/stores/auth';
import { sanitizeMarkedHtml } from '@/utils/sanitize';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const doc = ref<Doc | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

// marked 配置：开启 GFM、换行转 <br>，与 docsify 默认行为一致
marked.setOptions({
  gfm: true,
  breaks: true,
});

// 渲染后的 HTML（marked 引擎，docsify 同款）
// 安全：marked v18 已移除内置 sanitize，渲染后必须经 sanitizeMarkedHtml 净化，
// 防止文档内容中的 <script>/<img onerror> 等恶意 HTML 触发存储型 XSS
const renderedHtml = computed(() => {
  if (!doc.value?.content) return '';
  try {
    const raw = marked.parse(doc.value.content, { async: false }) as string;
    return sanitizeMarkedHtml(raw);
  } catch (e) {
    console.error('[DocsifyReader] marked 渲染失败', e);
    return `<p style="color:#c00">Markdown 渲染失败</p>`;
  }
});

// 是否可编辑：admin 全权；editor 仅可编辑自己创建的；viewer 不可
const canEdit = computed(() => {
  if (!doc.value) return false;
  const role = authStore.user?.role;
  if (role === 'admin') return true;
  if (role === 'editor' && doc.value.createdBy === authStore.user?.id) {
    return true;
  }
  return false;
});

async function loadDoc() {
  const id = route.params.docId as string;
  if (!id) {
    error.value = '缺少文档 id';
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    doc.value = await getDocument(id);
    if (doc.value.format !== 'md' && doc.value.contentSource !== 'ai_summary') {
      // 非 Markdown 文档提示（阅读视图专为 Markdown/总结文档设计）
      ElMessage.warning('该文档非 Markdown，阅读视图可能显示异常');
    }
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? e?.message ?? '加载文档失败';
  } finally {
    loading.value = false;
  }
}

function goBack() {
  // 优先返回上一页，无历史则回首页
  if (window.history.length > 1) {
    router.back();
  } else {
    router.push('/');
  }
}

function viewSource() {
  if (doc.value?.sourceDocId) {
    router.push(`/d/${doc.value.sourceDocId}`);
  }
}

function goEdit() {
  if (doc.value) {
    router.push(`/d/${doc.value.id}`);
  }
}

onMounted(loadDoc);
watch(() => route.params.docId, loadDoc);
</script>

<style scoped>
.docsify-reader {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #fff;
}
.reader-bar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 24px;
  background: #fff;
  border-bottom: 1px solid #eaecef;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
.reader-title {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
  color: #2c3e50;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reader-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.reader-main {
  flex: 1;
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 24px 80px;
}
.reader-loading {
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>

<!--
  Docsify 风格主题：复刻 docsify 默认 Vue 主题的阅读区排版
  （docsify 本身即 marked 渲染 + 该主题样式，此处等价于 docsify 渲染效果，
   且不依赖 docsify 的文件路由/CDN，适配内网无外网环境）
-->
<style>
.docsify-theme {
  color: #34495e;
  font-size: 16px;
  line-height: 1.7;
  word-wrap: break-word;
}
.docsify-theme h1,
.docsify-theme h2,
.docsify-theme h3,
.docsify-theme h4,
.docsify-theme h5,
.docsify-theme h6 {
  margin: 1.6em 0 0.6em;
  font-weight: 600;
  color: #2c3e50;
  line-height: 1.25;
}
.docsify-theme h1 {
  font-size: 1.9em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid #eaecef;
}
.docsify-theme h2 {
  font-size: 1.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid #eaecef;
}
.docsify-theme h3 {
  font-size: 1.25em;
}
.docsify-theme h4 {
  font-size: 1.05em;
}
.docsify-theme p {
  margin: 1em 0;
}
.docsify-theme a {
  color: #42b983;
  text-decoration: none;
}
.docsify-theme a:hover {
  text-decoration: underline;
}
.docsify-theme ul,
.docsify-theme ol {
  margin: 1em 0;
  padding-left: 1.6em;
}
.docsify-theme li {
  margin: 0.4em 0;
}
.docsify-theme blockquote {
  margin: 1em 0;
  padding: 0.5em 1em;
  color: #6a737d;
  border-left: 4px solid #42b983;
  background: #f6f8fa;
  border-radius: 0 4px 4px 0;
}
.docsify-theme code {
  padding: 0.2em 0.4em;
  margin: 0 2px;
  font-size: 0.9em;
  background: #f6f8fa;
  border-radius: 3px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
}
.docsify-theme pre {
  padding: 16px;
  margin: 1em 0;
  overflow: auto;
  font-size: 0.9em;
  line-height: 1.5;
  background: #f6f8fa;
  border-radius: 6px;
}
.docsify-theme pre code {
  padding: 0;
  margin: 0;
  background: transparent;
}
.docsify-theme table {
  display: block;
  width: 100%;
  overflow: auto;
  margin: 1em 0;
  border-collapse: collapse;
}
.docsify-theme table th,
.docsify-theme table td {
  padding: 8px 12px;
  border: 1px solid #dfe2e5;
}
.docsify-theme table th {
  background: #f6f8fa;
  font-weight: 600;
}
.docsify-theme img {
  max-width: 100%;
}
.docsify-theme hr {
  height: 1px;
  margin: 2em 0;
  border: 0;
  background: #eaecef;
}
</style>

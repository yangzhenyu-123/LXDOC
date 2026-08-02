<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
// pdfjs-dist v4+ 为 ESM 包，整体导入
import * as pdfjsLib from 'pdfjs-dist';

// 设置 worker：Vite 项目用 new URL 形式，构建时会单独打包 worker chunk
// pdfjs-dist v4 的 worker 文件为 .mjs（v3 为 .js）；S7: 升级 v4 修复 CVE-2024-4367
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;

const props = defineProps<{
  // pdf 文件签名 URL，例如 /api/files/<docId>/original?token=<fileToken>
  src: string;
}>();

// 渲染画布引用
const canvasRef = ref<HTMLCanvasElement | null>(null);

// 加载 / 渲染状态
const loading = ref(true);
const error = ref<string | null>(null);

// 当前页码（1-based）与总页数
const currentPage = ref(1);
const totalPages = ref(0);

// 缩放比例，范围 0.5~3，步进 0.25
const scale = ref(1);

// 已加载的 pdf 文档代理
let pdfDoc: any = null;
// 当前进行中的渲染任务，便于切换页码/缩放或卸载时取消，避免后台渲染与报错
let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
// 组件是否已卸载：卸载后异步回调不再写状态
let destroyed = false;

/**
 * 渲染当前页到 canvas
 */
async function renderPage() {
  if (!pdfDoc) return;
  // 取消上一次未完成的渲染
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {
      // ignore
    }
  }
  try {
    const page = await pdfDoc.getPage(currentPage.value);
    if (destroyed || !pdfDoc) return;
    const viewport = page.getViewport({ scale: scale.value });
    const canvas = canvasRef.value;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const task = page.render({ canvasContext: ctx, viewport });
    renderTask = task;
    await task.promise;
  } catch (err: any) {
    // 切换页码/缩放会触发取消，属正常流程，静默
    if (err?.name === 'RenderingCancelledException') return;
    console.error('[PdfViewer] 渲染失败', err);
  }
}

/**
 * 加载 pdf 文档
 */
async function loadPdf() {
  loading.value = true;
  error.value = null;
  try {
    pdfDoc = await pdfjsLib.getDocument({
      url: props.src,
      // cMapUrl：pdfjs 按需加载 CID 字体映射表（中文/日文/韩文等非拉丁字体）
      // 不配置时中文 PDF 渲染会丢字（文字消失）。cmaps 已由 Dockerfile 复制到 public/pdfjs-cmaps
      cMapUrl: '/pdfjs-cmaps/',
      cMapPacked: true,
    }).promise;
    if (destroyed) {
      // 加载过程中组件已卸载，立即释放
      try {
        pdfDoc.destroy();
      } catch {
        // ignore
      }
      pdfDoc = null;
      return;
    }
    totalPages.value = pdfDoc.numPages;
    currentPage.value = 1;
    await renderPage();
  } catch (err: any) {
    if (destroyed) return;
    error.value = err?.message ?? '加载 PDF 失败';
  } finally {
    if (!destroyed) {
      loading.value = false;
    }
  }
}

// 上一页
function prevPage() {
  if (currentPage.value <= 1) return;
  currentPage.value -= 1;
}

// 下一页
function nextPage() {
  if (currentPage.value >= totalPages.value) return;
  currentPage.value += 1;
}

// 缩小
function zoomOut() {
  scale.value = Math.max(0.5, Math.round((scale.value - 0.25) * 100) / 100);
}

// 放大
function zoomIn() {
  scale.value = Math.min(3, Math.round((scale.value + 0.25) * 100) / 100);
}

// 下载：直接打开原 URL
function download() {
  window.open(props.src, '_blank');
}

// 页码变化时重新渲染
watch(currentPage, () => {
  renderPage();
});

// 缩放变化时重新渲染
watch(scale, () => {
  renderPage();
});

// src 变化时重新加载
watch(
  () => props.src,
  (newSrc) => {
    if (newSrc) loadPdf();
  },
);

onMounted(() => {
  if (props.src) loadPdf();
});

// 卸载时释放 pdfjs 资源：取消进行中的渲染任务并销毁文档代理
// 否则 PDF worker 线程与内存不会回收，频繁切换文档会累积泄漏
onBeforeUnmount(() => {
  destroyed = true;
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {
      // ignore
    }
    renderTask = null;
  }
  if (pdfDoc) {
    try {
      pdfDoc.destroy();
    } catch {
      // ignore
    }
    pdfDoc = null;
  }
});
</script>

<template>
  <div class="pdf-viewer">
    <!-- 工具栏 -->
    <div class="toolbar">
      <el-button-group>
        <el-button
          :disabled="currentPage <= 1"
          size="small"
          @click="prevPage"
        >
          上一页
        </el-button>
        <el-button
          :disabled="currentPage >= totalPages"
          size="small"
          @click="nextPage"
        >
          下一页
        </el-button>
      </el-button-group>
      <span class="page-info">
        {{ currentPage }} / {{ totalPages || '-' }}
      </span>
      <el-button-group>
        <el-button size="small" @click="zoomOut">-</el-button>
        <el-button size="small" disabled>{{ Math.round(scale * 100) }}%</el-button>
        <el-button size="small" @click="zoomIn">+</el-button>
      </el-button-group>
      <el-button size="small" @click="download">
        <el-icon class="el-icon--left"><Download /></el-icon>
        下载
      </el-button>
    </div>

    <!-- 主体渲染区 -->
    <div class="canvas-wrap" v-loading="loading">
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        show-icon
        :closable="false"
        class="error-alert"
      />
      <canvas v-show="!error" ref="canvasRef" class="pdf-canvas" />
    </div>
  </div>
</template>

<style scoped>
.pdf-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f5f7fa;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  flex-wrap: wrap;
}
.page-info {
  font-size: 13px;
  color: #606266;
  min-width: 80px;
  text-align: center;
}
.canvas-wrap {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px;
}
.error-alert {
  width: 100%;
  max-width: 800px;
  margin-bottom: 12px;
}
.pdf-canvas {
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  max-width: 100%;
}
</style>

<template>
  <div class="onlyoffice-editor">
    <div v-if="loading" class="oo-loading" v-loading="true" />
    <el-alert
      v-else-if="error"
      :title="error"
      type="error"
      show-icon
      :closable="false"
    />
    <div v-show="!loading && !error" ref="containerRef" class="oo-container" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getOnlyOfficeConfig, type OnlyOfficeConfig } from '@/api/documents';

/**
 * OnlyOffice DocsAPI 声明（来自动态注入的 api.js）
 * 仅声明用到的方法/字段，避免引入第三方 .d.ts
 */
interface DocsAPIDocEditor {
  destroy(): void;
}
interface DocsAPI {
  DocEditor: new (
    el: HTMLElement,
    config: OnlyOfficeConfig & {
      events?: Record<string, (e: { data?: unknown }) => void>;
      height?: string;
      width?: string;
    },
  ) => DocsAPIDocEditor;
}
declare global {
  interface Window {
    DocsAPI?: DocsAPI;
  }
}

const props = defineProps<{
  docId: string;
  /** edit / view，省略时后端按权限决定 */
  mode?: 'edit' | 'view';
}>();

const emit = defineEmits<{
  (e: 'saved'): void;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

let editor: DocsAPIDocEditor | null = null;

// ============================================================
// 模块级：api.js 共享加载与引用计数
// 多个 OnlyOfficeEditor 实例共享同一个 api.js 脚本，
// 引用计数保证只有最后一个实例卸载时才移除 <script>，
// 避免实例 A 卸载移除脚本导致实例 B 的 DocsAPI 失效。
// ============================================================
let apiPromise: Promise<DocsAPI> | null = null;
let apiRefCount = 0;

/**
 * OnlyOffice api.js 地址，由 VITE_ONLYOFFICE_URL 决定
 * 默认同源反代 /onlyoffice（vite.config + 后端反代或 nginx 处理）
 */
const ooBaseUrl = (
  import.meta.env.VITE_ONLYOFFICE_URL ?? '/onlyoffice'
) as string;
const apiJsUrl = `${ooBaseUrl.replace(/\/$/, '')}/web-apps/apps/api/documents/api.js`;

/**
 * 动态注入 api.js（仅一次），返回 window.DocsAPI
 * 失败抛错，由调用方捕获显示降级提示
 */
function loadApi(): Promise<DocsAPI> {
  if (window.DocsAPI) {
    return Promise.resolve(window.DocsAPI);
  }
  if (apiPromise) {
    return apiPromise;
  }
  apiPromise = new Promise<DocsAPI>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = apiJsUrl;
    el.async = true;
    el.onload = () => {
      if (window.DocsAPI) {
        resolve(window.DocsAPI);
      } else {
        apiPromise = null;
        reject(new Error('OnlyOffice api.js 加载后 DocsAPI 仍缺失'));
      }
    };
    el.onerror = () => {
      apiPromise = null;
      // 失败时移除脚本以便下次重试
      if (el.parentNode) el.parentNode.removeChild(el);
      reject(new Error(`无法加载 OnlyOffice 脚本：${apiJsUrl}`));
    };
    document.head.appendChild(el);
  });
  return apiPromise;
}

/**
 * 占用一次 api.js 引用（组件挂载时调用）
 */
function acquireApi(): void {
  apiRefCount++;
}

/**
 * 释放一次 api.js 引用（组件卸载时调用）
 * 引用归零时移除 <script> 标签并重置加载状态，避免 DOM 残留
 */
function releaseApi(): void {
  apiRefCount = Math.max(0, apiRefCount - 1);
  if (apiRefCount === 0) {
    const el = document.querySelector(`script[src="${apiJsUrl}"]`);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    apiPromise = null;
    // window.DocsAPI 保留（脚本执行后已挂载到内存），下次 loadApi 直接复用
  }
}

// ============================================================
// 实例级：串行锁 + initToken
// 快速切换 docId/mode 时可能连续触发 init，串行锁确保任意时刻只有一个
// init 在执行（避免并发 new DocEditor 产生两个 iframe）；
// initToken 用于丢弃过期 init 的异步结果（已被更新的 init 接管）。
// ============================================================
let initSeq: Promise<void> = Promise.resolve();
let initToken = 0;
// onError 自动重建标志：仅重建一次，避免错误死循环
let rebuilding = false;

/**
 * 初始化编辑器
 * 1. 拉后端 config（含 fileUrl + JWT token）
 * 2. 注入 api.js 后 new DocsAPI.DocEditor(el, config)
 * 3. 监听保存成功事件 → emit('saved') 通知父组件刷新版本下拉
 */
async function init(): Promise<void> {
  const token = ++initToken;
  // 串行：等待上一次 init 结束（含失败）
  const prev = initSeq;
  let release!: () => void;
  initSeq = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    await prev;
    // 已有更新的 init 接管，本次结果作废
    if (token !== initToken) return;

    loading.value = true;
    error.value = null;

    const config = await getOnlyOfficeConfig(props.docId, props.mode);
    if (token !== initToken) return;
    const api = await loadApi();
    if (token !== initToken) return;
    if (!containerRef.value) return;

    // 销毁旧编辑器（重建场景）
    destroyEditor();

    const fullConfig: OnlyOfficeConfig & {
      events?: Record<string, (e: { data?: unknown }) => void>;
      height?: string;
      width?: string;
    } = {
      ...config,
      height: '100%',
      width: '100%',
      events: {
        // 保存到服务器成功（回调处理完成）
        onDocumentReady: () => {
          // 文档已就绪
        },
        onSave: (e: { data?: unknown }) => {
          // 旧版本事件名，新版本由 onDocumentStateChange + 后端回调处理
          void e;
          ElMessage.success('文档已保存');
          emit('saved');
        },
        onError: (e: { data?: unknown }) => {
          console.error('[OnlyOffice] onError', e?.data);
          // 自动重建一次，避免一次瞬态错误导致编辑器永久不可用
          if (!rebuilding) {
            rebuilding = true;
            ElMessage.warning('OnlyOffice 异常，正在尝试重建');
            destroyEditor();
            void init().finally(() => {
              rebuilding = false;
            });
          } else {
            ElMessage.error('OnlyOffice 编辑器异常');
            error.value = 'OnlyOffice 编辑器异常，已尝试重建仍未恢复';
          }
        },
        onOutdatedVersion: () => {
          ElMessage.warning('文档版本已过期，正在重新加载');
          destroyEditor();
          void init();
        },
      },
    };

    editor = new api.DocEditor(containerRef.value, fullConfig);
  } catch (err: any) {
    if (token !== initToken) return;
    error.value =
      err?.response?.data?.message ?? err?.message ?? 'OnlyOffice 初始化失败';
  } finally {
    if (token === initToken) {
      loading.value = false;
    }
    release();
  }
}

function destroyEditor(): void {
  if (editor) {
    try {
      editor.destroy();
    } catch {
      // 忽略销毁异常
    }
    editor = null;
  }
}

onMounted(() => {
  acquireApi();
  void init();
});

onBeforeUnmount(() => {
  // 使进行中的 init 异步结果失效
  initToken++;
  destroyEditor();
  releaseApi();
});

// 切换 docId 或 mode 时重建
watch(
  () => [props.docId, props.mode],
  () => {
    void init();
  },
);
</script>

<style scoped>
.onlyoffice-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.oo-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.oo-container {
  flex: 1;
  min-height: 0;
  width: 100%;
}
.oo-container :deep(iframe) {
  width: 100%;
  height: 100%;
  border: 0;
}
</style>

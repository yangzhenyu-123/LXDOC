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
let scriptEl: HTMLScriptElement | null = null;

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
  return new Promise((resolve, reject) => {
    scriptEl = document.createElement('script');
    scriptEl.src = apiJsUrl;
    scriptEl.async = true;
    scriptEl.onload = () => {
      if (window.DocsAPI) {
        resolve(window.DocsAPI);
      } else {
        reject(new Error('OnlyOffice api.js 加载后 DocsAPI 仍缺失'));
      }
    };
    scriptEl.onerror = () => {
      reject(new Error(`无法加载 OnlyOffice 脚本：${apiJsUrl}`));
    };
    document.head.appendChild(scriptEl);
  });
}

/**
 * 初始化编辑器
 * 1. 拉后端 config（含 fileUrl + JWT token）
 * 2. 注入 api.js 后 new DocsAPI.DocEditor(el, config)
 * 3. 监听保存成功事件 → emit('saved') 通知父组件刷新版本下拉
 */
async function init() {
  loading.value = true;
  error.value = null;
  try {
    const config = await getOnlyOfficeConfig(props.docId, props.mode);
    const api = await loadApi();
    if (!containerRef.value) return;

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
          ElMessage.error('OnlyOffice 编辑器异常');
          console.error('[OnlyOffice] onError', e?.data);
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
    const msg =
      err?.response?.data?.message ?? err?.message ?? 'OnlyOffice 初始化失败';
    error.value = msg;
  } finally {
    loading.value = false;
  }
}

function destroyEditor() {
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
  void init();
});

onBeforeUnmount(() => {
  destroyEditor();
  if (scriptEl && scriptEl.parentNode) {
    scriptEl.parentNode.removeChild(scriptEl);
    scriptEl = null;
  }
});

// 切换 docId 或 mode 时重建
watch(
  () => [props.docId, props.mode],
  () => {
    destroyEditor();
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

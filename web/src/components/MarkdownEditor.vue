<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
// Vditor 是浏览器端组件，需在 onMounted 内初始化（依赖 window）
import Vditor from 'vditor';
// 必须引入 Vditor 自带的样式
import 'vditor/dist/index.css';
import { uploadImage } from '@/api/uploads';
import { rewriteImageUrls, stripFileTokens } from '@/api/files';

const props = defineProps<{
  // 受控内容（不含文件 token，存库内容保持干净）
  modelValue: string;
  // 用于图片上传路径（可选）
  docId?: string;
  // 文件访问签名 token，渲染时拼到 /api/files/... 图片 URL 上（可选）
  fileToken?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'save'): void;
}>();

// 编辑器挂载容器引用
const containerRef = ref<HTMLDivElement>();
// Vditor 实例，初始化后赋值
let vditor: Vditor | null = null;
// 内部同步标记：避免 input 回调触发 setValue 时再次回灌外部
let internalUpdate = false;

/**
 * 初始化 Vditor 实例
 * 必须在 onMounted 内执行以确保 window 已就绪
 */
function initVditor() {
  if (!containerRef.value) return;

  vditor = new Vditor(containerRef.value, {
    value: rewriteImageUrls(props.modelValue ?? '', props.fileToken ?? ''),
    // 即时渲染模式
    mode: 'ir',
    height: '70vh',
    toolbar: [
      'headings', 'bold', 'italic', '|',
      'link', 'list', 'ordered-list', 'check', 'quote', 'line', '|',
      'code', 'inline-code', 'table', '|',
      'upload', 'preview', 'outline', '|',
      'undo', 'redo', 'edit-mode', 'fullscreen',
    ],
    cache: { enable: false },
    preview: {
      hljs: { lineNumber: true, style: 'github' },
    },
    upload: {
      accept: 'image/*',
      // 自定义图片上传：调用后端 /api/uploads/image
      handler: async (files: File[]) => {
        const urls: string[] = [];
        for (const f of files) {
          const res = await uploadImage(f, props.docId);
          urls.push(res.url);
        }
        // 在光标处插入图片 markdown
        vditor?.insertValue(urls.map((u) => `![](${u})`).join('\n'));
        return null;
      },
    },
    input: (value: string) => {
      // 标记本次为内部 setValue 引发的 input，避免回环
      if (internalUpdate) return;
      // 回灌前剥离文件 token，保证存库内容不含短期 token
      emit('update:modelValue', stripFileTokens(value));
    },
    ctrlEnter: () => {
      // Ctrl/Cmd + Enter 触发保存
      emit('save');
    },
  });

  // 额外监听 Ctrl/Cmd + S 触发保存（与 ctrlEnter 并存）
  containerRef.value.addEventListener('keydown', onSaveShortcut);
}

/**
 * Ctrl/Cmd + S 快捷键处理：阻止默认保存并触发 save 事件
 */
function onSaveShortcut(e: KeyboardEvent) {
  const isSaveShortcut =
    (e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S');
  if (isSaveShortcut) {
    e.preventDefault();
    emit('save');
  }
}

/**
 * 监听外部 modelValue 变化：仅在与编辑器当前值不一致时调用 setValue，避免光标跳动
 * setValue 前把图片 URL 拼上文件 token，使编辑器内图片可加载
 */
watch(
  () => props.modelValue,
  (newVal) => {
    if (!vditor) return;
    const display = rewriteImageUrls(newVal ?? '', props.fileToken ?? '');
    const current = vditor.getValue();
    if (display !== current) {
      internalUpdate = true;
      vditor.setValue(display);
      // 下一个事件循环后解除标记，确保 input 回调已触发完毕
      setTimeout(() => {
        internalUpdate = false;
      }, 0);
    }
  },
);

onMounted(() => {
  initVditor();
});

onBeforeUnmount(() => {
  if (containerRef.value) {
    containerRef.value.removeEventListener('keydown', onSaveShortcut);
  }
  if (vditor) {
    vditor.destroy();
    vditor = null;
  }
});
</script>

<template>
  <div ref="containerRef" class="markdown-editor" />
</template>

<style scoped>
.markdown-editor {
  width: 100%;
}
</style>

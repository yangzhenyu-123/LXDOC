<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowLeft, ArrowRight, ArrowDown, ChatLineRound, CircleClose, Document, Loading, Promotion } from '@element-plus/icons-vue';
import { marked } from 'marked';
import { useAuthStore } from '@/stores/auth';
import { sanitizeMarkedHtml } from '@/utils/sanitize';
import { extractRefTokens, replaceRefPlaceholders } from '@/utils/rag-refs';
import { useStreamSmoother } from '@/composables/useStreamSmoother';
import { getKb, askStream, retrieve, listKbs, getKbStats, listKbDocuments, getChunk, generateSampleQuestions, createMessageFeedback, type KnowledgeBase, type KbStats, type KbDocument, type RagEvent, type RagReference, type RagConfidence, type HistoryMessage, type ChunkDetail } from '@/api/kb';

/**
 * RAG 知识库问答页（核心）
 *
 * 功能：
 * - 选择知识库 → 输入问题 → SSE 流式接收
 * - 思考链折叠展示（reasoning 事件）
 * - 正文实时 markdown 渲染（delta 事件累加）
 * - 引用列表展示 + [1][2] 上标可点击高亮对应引用
 * - 状态 UI：拒答 / 降级标注 / 错误 / 中断
 * - 用户中断按钮（AbortController）
 *
 * 设计参考：P4 调研 8 项目结论
 * - SSE + type 字段协议
 * - 引用双轨制：后端 references 事件保底 + LLM 内联 [1][2] 增强
 * - 思考链独立折叠区
 */

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

// ============ 知识库选择 ============

const kbs = ref<KnowledgeBase[]>([]);
const currentKb = ref<KnowledgeBase | null>(null);
const currentStats = ref<KbStats | null>(null);
const kbLoading = ref(false);

// ============ 聊天状态 ============

interface ChatMessage {
  // 用户问题
  role: 'user' | 'assistant';
  content: string;
  // assistant 消息的引用元数据（来自 references 事件）
  refs?: RagReference[];
  // assistant 消息的思考链（来自 reasoning 事件累加）
  reasoning?: string;
  // 是否降级回答（isFallback）
  isFallback?: boolean;
  // 是否被用户中断
  cancelled?: boolean;
  // 错误消息（error 事件）
  error?: string;
  // 状态：streaming / done / error / cancelled
  status: 'streaming' | 'done' | 'error' | 'cancelled';
  // P9 候选 3：done 事件返回的消息 id（用于反馈评分）
  messageId?: string;
  // 置信度等级（done 事件返回，前端展示徽章）
  confidence?: RagConfidence;
  // 用户已提交的反馈评分：1=点赞 / -1=点踩 / undefined=未反馈
  feedbackRating?: 1 | -1;
  // 反馈是否已提交（防重复点击）
  feedbackSubmitted?: boolean;
}

const messages = ref<ChatMessage[]>([]);
const inputQuery = ref('');
const streaming = ref(false);
// 当前流的 AbortController（中断用）
let abortController: AbortController | null = null;
// 当前正在流式的 assistant 消息索引（用于实时更新）
const streamingIdx = ref(-1);

// 聊天容器引用（用于自动滚动到底部）
const chatScrollRef = ref<HTMLElement | null>(null);

// 引用列表是否展开（每条 assistant 消息独立）
const refsExpanded = ref<Record<number, boolean>>({});
// 思考链是否展开（每条 assistant 消息独立）
const reasoningExpanded = ref<Record<number, boolean>>({});

// 文档选择器：限定检索的文档范围（F6）
// 空数组 = 全 KB 检索；非空 = 只在选中文档中检索
const selectedDocIds = ref<string[]>([]);
// 知识库文档列表（用于 F6 文档选择器下拉）
const kbDocuments = ref<KbDocument[]>([]);
// 文档选择器下拉是否展开
const docSelectorVisible = ref(false);

// 引用预览弹窗（F4）
const chunkPreviewVisible = ref(false);
const chunkPreviewLoading = ref(false);
const chunkPreviewData = ref<ChunkDetail | null>(null);
// 预览弹窗顶部展示的文档标题（从 ref 取，避免再查文档）
const chunkPreviewDocTitle = ref('');

// ============ P9 候选 2：流式打字机平滑器 ============
//
// 解决 SSE 速率不稳定导致"卡顿→突然蹦一大段"的体验问题。
// pushContent/pushReasoning 累积增量，rAF 节流后通过 onEmit 回调更新 msg。
// 在 done/cancelled/error 时 flush 强制吐完，避免残留缓冲。
const streamSmoother = useStreamSmoother();

// ============ 计算属性 ============

const isEmpty = computed(() => messages.value.length === 0);

// ============ 加载知识库 ============

async function loadKbs() {
  kbLoading.value = true;
  try {
    kbs.value = await listKbs();
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '加载知识库列表失败');
    kbs.value = [];
  } finally {
    kbLoading.value = false;
  }
}

async function loadCurrentKb(id: string) {
  kbLoading.value = true;
  try {
    const [kb, stats, docs] = await Promise.all([
      getKb(id),
      getKbStats(id).catch(() => null),
      listKbDocuments(id).catch(() => [] as KbDocument[]),
    ]);
    currentKb.value = kb;
    currentStats.value = stats;
    kbDocuments.value = docs;
    // 切换 KB 时重置文档选择器（避免上次选择残留到新 KB）
    selectedDocIds.value = [];
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '加载知识库失败');
    router.push('/kb');
  } finally {
    kbLoading.value = false;
  }
}

// ============ 发送问题 ============

async function sendQuery() {
  const q = inputQuery.value.trim();
  if (!q || streaming.value) return;
  inputQuery.value = '';
  await doSend(q);
}

/**
 * 实际发起提问（R4：示例问题快捷入口也复用此函数）
 * 抽取自 sendQuery，便于以任意 query 触发流式问答。
 */
async function doSend(q: string) {
  if (!q || streaming.value) return;
  if (!currentKb.value) {
    ElMessage.warning('请先选择知识库');
    return;
  }

  // 用户消息
  messages.value.push({ role: 'user', content: q, status: 'done' });

  // assistant 占位消息
  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: '',
    reasoning: '',
    refs: [],
    status: 'streaming',
  };
  messages.value.push(assistantMsg);
  streamingIdx.value = messages.value.length - 1;
  // 默认展开思考链（流式时让用户看到推理过程）
  reasoningExpanded.value[streamingIdx.value] = true;
  // 默认折叠引用列表（流结束后展开）
  refsExpanded.value[streamingIdx.value] = false;

  streaming.value = true;
  abortController = new AbortController();

  // 重置 smoother + 注册 emit 回调把增量更新到当前 assistant 消息
  streamSmoother.reset();
  streamSmoother.onEmit((delta) => {
    const m = messages.value[streamingIdx.value];
    if (!m) return;
    if (delta.content) m.content += delta.content;
    if (delta.reasoning) m.reasoning = (m.reasoning ?? '') + delta.reasoning;
    // 触发自动滚动（rAF 节流后渲染）
    scheduleAutoScroll();
  });

  // 构造历史对话（多轮对话）：取已完成的 user + assistant 消息对
  // 过滤掉 streaming/error/cancelled 状态的 assistant 消息（未完成的不传）
  const history: HistoryMessage[] = [];
  for (const m of messages.value) {
    if (m.role === 'user') {
      history.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant' && m.status === 'done') {
      history.push({ role: 'assistant', content: m.content });
    }
  }
  // 排除当前刚加的 user 消息（它已是当前 query，不重复传）
  history.pop();

  try {
    for await (const evt of askStream(currentKb.value.id, q, abortController.signal, {
      history,
      ...(selectedDocIds.value.length > 0 ? { documentIds: selectedDocIds.value } : {}),
    })) {
      const msg = messages.value[streamingIdx.value];
      if (!msg) break;
      handleEvent(evt, msg, streamingIdx.value);
    }
  } catch (err: any) {
    const msg = messages.value[streamingIdx.value];
    if (msg) {
      if (err?.name === 'AbortError' || abortController?.signal.aborted) {
        msg.status = 'cancelled';
        msg.cancelled = true;
      } else {
        msg.status = 'error';
        msg.error = err?.message ?? '生成失败';
      }
    }
  } finally {
    // 流式结束：强制吐完 smoother 缓冲，避免残留字符不显示
    streamSmoother.flush();
    streaming.value = false;
    abortController = null;
    // 流结束后折叠思考链（用户可手动展开回顾）
    if (streamingIdx.value >= 0) {
      reasoningExpanded.value[streamingIdx.value] = false;
    }
    streamingIdx.value = -1;
    await scrollToBottom();
  }
}

/**
 * 处理单个 SSE 事件，更新当前 assistant 消息
 *
 * P9 候选 2：delta/reasoning 事件改为推入 smoother（rAF 节流 emit），
 * 不再直接累加 msg.content。done/cancelled/error 时由 finally 中 flush 强制吐完。
 */
function handleEvent(evt: RagEvent, msg: ChatMessage, idx: number) {
  switch (evt.type) {
    case 'references':
      msg.refs = evt.refs;
      // 有引用时默认展开引用列表
      if (evt.refs.length > 0) {
        refsExpanded.value[idx] = true;
      }
      break;
    case 'reasoning':
      streamSmoother.pushReasoning(evt.content);
      break;
    case 'delta':
      streamSmoother.pushContent(evt.content);
      break;
    case 'done':
      msg.content = evt.answer; // 用后端最终 answer 校正（与 delta 拼接应一致）
      msg.isFallback = evt.isFallback;
      msg.messageId = evt.messageId;
      msg.confidence = evt.confidence;
      msg.status = 'done';
      break;
    case 'error':
      msg.status = 'error';
      msg.error = evt.message;
      break;
    case 'cancelled':
      msg.status = 'cancelled';
      msg.cancelled = true;
      break;
  }
}

/**
 * 中断当前流式生成
 */
function stopStream() {
  if (abortController) {
    abortController.abort();
  }
}

/**
 * 清空对话
 */
function clearChat() {
  if (streaming.value) {
    ElMessage.warning('请先停止当前生成');
    return;
  }
  messages.value = [];
}

// ============ P9 候选 3：消息反馈 ============

/** 点踩理由弹窗状态 */
const feedbackDialogVisible = ref(false);
const feedbackDialogReason = ref('');
const feedbackDialogLoading = ref(false);
// 当前正在提交反馈的消息索引 + 待提交的 rating
let pendingFeedbackIdx = -1;
let pendingFeedbackRating: 1 | -1 = 1;

/**
 * 提交反馈：点赞直接发，点踩先弹窗写理由
 */
async function onSubmitFeedback(idx: number, rating: 1 | -1) {
  const msg = messages.value[idx];
  if (!msg || !msg.messageId || !currentKb.value || msg.feedbackSubmitted) return;

  if (rating === -1) {
    // 点踩先弹窗
    pendingFeedbackIdx = idx;
    pendingFeedbackRating = -1;
    feedbackDialogReason.value = '';
    feedbackDialogVisible.value = true;
    return;
  }

  // 点赞直接提交
  await doSubmitFeedback(idx, 1);
}

/**
 * 点踩弹窗确认提交
 */
async function onConfirmFeedback() {
  if (pendingFeedbackIdx < 0) return;
  const reason = feedbackDialogReason.value.trim();
  if (!reason) {
    ElMessage.warning('请填写不满意的原因');
    return;
  }
  await doSubmitFeedback(pendingFeedbackIdx, -1, reason);
  feedbackDialogVisible.value = false;
}

/**
 * 实际调用 API 提交反馈
 */
async function doSubmitFeedback(idx: number, rating: 1 | -1, reason?: string) {
  const msg = messages.value[idx];
  if (!msg || !msg.messageId || !currentKb.value) return;

  feedbackDialogLoading.value = true;
  try {
    await createMessageFeedback(currentKb.value.id, msg.messageId, rating, reason);
    msg.feedbackRating = rating;
    msg.feedbackSubmitted = true;
    ElMessage.success(rating === 1 ? '感谢反馈' : '已记录您的反馈');
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '提交反馈失败');
  } finally {
    feedbackDialogLoading.value = false;
  }
}

/** 置信度徽章元数据 */
function confidenceMeta(c?: RagConfidence): { text: string; cls: string } | null {
  if (!c) return null;
  switch (c) {
    case 'high': return { text: '高置信', cls: 'confidence-high' };
    case 'medium': return { text: '中置信', cls: 'confidence-medium' };
    case 'low': return { text: '低置信', cls: 'confidence-low' };
    case 'none': return { text: '无引用', cls: 'confidence-none' };
  }
}

// ============ UI 辅助 ============

async function scrollToBottom() {
  await nextTick();
  const el = chatScrollRef.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
}

/**
 * rAF 节流的自动滚动：smoother 每个 emit 帧都触发会过频，
 * 用 rAF 合并到下一帧统一滚动一次。
 */
let autoScrollScheduled = false;
function scheduleAutoScroll() {
  if (autoScrollScheduled) return;
  autoScrollScheduled = true;
  requestAnimationFrame(() => {
    autoScrollScheduled = false;
    const el = chatScrollRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/**
 * 渲染 markdown 为安全 HTML
 * P9 候选 1：引用 [1][2] 转为带文档名 + 图标的 pill（hover 悬浮卡 + 点击高亮底部引用）
 */
function renderAnswer(md: string, msgIdx: number, refs?: RagReference[]): string {
  if (!md) return '';
  // 引用替换逻辑提取为纯函数（src/utils/rag-refs.ts），便于单元测试
  const { preprocessed, tokens } = extractRefTokens(md);
  const html = marked.parse(preprocessed, { async: false }) as string;
  const safe = sanitizeMarkedHtml(html);
  return replaceRefPlaceholders(safe, tokens, msgIdx, refs);
}

/**
 * 点击引用 pill：滚动到引用列表并高亮
 * P9 候选 1：支持点击 pill（rag-ref-pill）和旧上标（rag-ref-tag）
 */
function onAnswerClick(e: MouseEvent) {
  const target = (e.target as HTMLElement)?.closest('.rag-ref-pill, .rag-ref-tag') as HTMLElement | null;
  if (!target) return;
  const refId = Number(target.dataset.ref);
  const msgIdx = Number(target.dataset.msg);
  if (!refId || Number.isNaN(msgIdx)) return;
  // 展开引用列表
  refsExpanded.value[msgIdx] = true;
  // 滚动到对应引用项并高亮
  nextTick(() => {
    const item = document.querySelector(`[data-ref-item="${msgIdx}-${refId}"]`);
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      item.classList.add('ref-highlight');
      setTimeout(() => item.classList.remove('ref-highlight'), 1500);
    }
  });
}

// ============ P9 候选 1：引用悬浮卡 ============
//
// hover pill 时拉取 chunk 全文显示在 pill 下方悬浮卡，会话级缓存避免重复请求。
// 鼠标移开 pill 时延迟 200ms 关闭，让用户能移到 popover 上点击"查看全文"。
const citationPopoverVisible = ref(false);
const citationPopoverPos = ref({ x: 0, y: 0 });
const citationPopoverData = ref<ChunkDetail | null>(null);
const citationPopoverLoading = ref(false);
const citationPopoverTitle = ref('');
// 会话级 chunk 缓存（key=chunkId，value=ChunkDetail）
const chunkCache = new Map<string, ChunkDetail>();
let popoverHideTimer: number | null = null;

function onAnswerMouseEnter(e: MouseEvent) {
  const target = (e.target as HTMLElement)?.closest('.rag-ref-pill') as HTMLElement | null;
  if (!target) return;
  const chunkId = target.dataset.chunkId;
  const docTitle = target.dataset.docTitle ?? '';
  if (!chunkId || !currentKb.value) return;

  // 取消隐藏定时器（如果用户从 popover 移回 pill）
  if (popoverHideTimer !== null) {
    clearTimeout(popoverHideTimer);
    popoverHideTimer = null;
  }

  // 定位悬浮卡到 pill 下方
  const rect = target.getBoundingClientRect();
  citationPopoverPos.value = {
    x: rect.left,
    y: rect.bottom + window.scrollY + 6,
  };
  citationPopoverTitle.value = docTitle;
  citationPopoverVisible.value = true;

  // 缓存命中直接显示
  if (chunkCache.has(chunkId)) {
    citationPopoverData.value = chunkCache.get(chunkId)!;
    citationPopoverLoading.value = false;
    return;
  }

  // 缓存未命中拉取
  citationPopoverData.value = null;
  citationPopoverLoading.value = true;
  getChunk(currentKb.value.id, chunkId)
    .then((chunk) => {
      chunkCache.set(chunkId, chunk);
      // 仅当 popover 仍显示当前 chunk 时才更新（防竞态）
      if (citationPopoverVisible.value) {
        citationPopoverData.value = chunk;
        citationPopoverLoading.value = false;
      }
    })
    .catch(() => {
      if (citationPopoverVisible.value) {
        citationPopoverLoading.value = false;
      }
    });
}

function onAnswerMouseLeave(e: MouseEvent) {
  const target = (e.target as HTMLElement)?.closest('.rag-ref-pill') as HTMLElement | null;
  if (!target) return;
  // 延迟关闭，让用户能移到 popover 上
  if (popoverHideTimer !== null) clearTimeout(popoverHideTimer);
  popoverHideTimer = window.setTimeout(() => {
    citationPopoverVisible.value = false;
    popoverHideTimer = null;
  }, 200);
}

/** 鼠标移入 popover 时取消关闭 */
function onPopoverEnter() {
  if (popoverHideTimer !== null) {
    clearTimeout(popoverHideTimer);
    popoverHideTimer = null;
  }
}

/** 鼠标移出 popover 时关闭 */
function onPopoverLeave() {
  if (popoverHideTimer !== null) clearTimeout(popoverHideTimer);
  citationPopoverVisible.value = false;
}

/** 点击 popover 中"查看全文"按钮：复用现有 chunkPreview 弹窗 */
function onPopoverViewFull() {
  if (!citationPopoverData.value) return;
  openChunkPreview({
    chunkId: citationPopoverData.value.id,
    documentTitle: citationPopoverTitle.value,
  } as any);
  citationPopoverVisible.value = false;
}

function toggleRefs(idx: number) {
  refsExpanded.value[idx] = !refsExpanded.value[idx];
}

function toggleReasoning(idx: number) {
  reasoningExpanded.value[idx] = !reasoningExpanded.value[idx];
}

// F4 打开 chunk 全文预览弹窗
async function openChunkPreview(ref: RagReference) {
  if (!currentKb.value) return;
  chunkPreviewVisible.value = true;
  chunkPreviewLoading.value = true;
  chunkPreviewData.value = null;
  chunkPreviewDocTitle.value = ref.documentTitle;
  try {
    chunkPreviewData.value = await getChunk(currentKb.value.id, ref.chunkId);
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '加载 chunk 失败');
    chunkPreviewVisible.value = false;
  } finally {
    chunkPreviewLoading.value = false;
  }
}

function formatScore(s: number): string {
  return s.toFixed(4);
}

function hitByTag(hitBy: string): '' | 'success' | 'warning' {
  if (hitBy === 'both') return 'success';
  if (hitBy === 'vector') return '';
  return 'warning';
}

function hitByLabel(hitBy: string): string {
  if (hitBy === 'both') return '向量+词法';
  if (hitBy === 'vector') return '向量';
  return '词法';
}

// ============ 路由同步 ============

async function syncFromRoute() {
  const id = route.params.id;
  if (id && typeof id === 'string') {
    await loadCurrentKb(id);
  }
}

watch(
  () => route.params.id,
  () => syncFromRoute(),
);

onMounted(async () => {
  await loadKbs();
  await syncFromRoute();
});

// ============ R4 示例问题 ============

const generatingSamples = ref(false);

/**
 * 调后端生成示例问题（LLM 基于文档列表生成）。
 * 生成成功后刷新 currentKb.sampleQuestions，UI 即时展示新 chips。
 */
async function onGenerateSamples() {
  if (!currentKb.value || generatingSamples.value) return;
  generatingSamples.value = true;
  try {
    const questions = await generateSampleQuestions(currentKb.value.id);
    currentKb.value = { ...currentKb.value, sampleQuestions: questions };
    ElMessage.success(`已生成 ${questions.length} 个示例问题`);
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '生成示例问题失败');
  } finally {
    generatingSamples.value = false;
  }
}

/**
 * 点击示例问题 chip：直接发起提问（不必先填输入框）。
 */
async function onPickSample(q: string) {
  if (streaming.value) return;
  await doSend(q);
}

// marked 配置：GFM + 换行转 <br>
marked.setOptions({ gfm: true, breaks: true });
</script>

<template>
  <div class="kb-ask-view" v-loading="kbLoading">
    <!-- 顶部栏：返回 + 知识库名 + 统计 + 清空 -->
    <header class="ask-header">
      <el-button text :icon="ArrowLeft" @click="router.push('/kb')">返回</el-button>
      <div class="kb-title-block" v-if="currentKb">
        <el-icon class="kb-title-icon"><ChatLineRound /></el-icon>
        <div class="kb-title-text">
          <div class="kb-title-name">{{ currentKb.name }}</div>
          <div class="kb-title-meta" v-if="currentStats">
            {{ currentStats.documentCount }} 篇文档 ·
            {{ currentStats.chunkCount }} chunks ·
            {{ currentStats.embeddedCount }} 已嵌入
          </div>
        </div>
      </div>
      <div class="ask-actions">
        <el-button text @click="clearChat" :disabled="streaming || isEmpty">清空对话</el-button>
      </div>
    </header>

    <!-- 知识库未选择提示 -->
    <div v-if="!currentKb && !kbLoading" class="kb-empty">
      <el-empty description="请从左侧选择知识库">
        <el-button type="primary" @click="router.push('/kb')">前往知识库列表</el-button>
      </el-empty>
    </div>

    <!-- 聊天主区 -->
    <main v-else class="chat-main">
      <div class="chat-scroll" ref="chatScrollRef">
        <!-- 空状态欢迎 -->
        <div v-if="isEmpty" class="welcome">
          <div class="welcome-icon">
            <el-icon size="48"><ChatLineRound /></el-icon>
          </div>
          <h2>知识库智能问答</h2>
          <p class="welcome-desc" v-if="currentKb">
            基于「{{ currentKb.name }}」的 {{ currentStats?.documentCount ?? 0 }} 篇文档进行检索增强回答
          </p>
          <!-- R4: 示例问题快捷入口 -->
          <div class="sample-questions" v-if="currentKb">
            <div class="sample-questions-header">
              <span class="sq-title">示例问题</span>
              <el-button
                text
                size="small"
                :loading="generatingSamples"
                :disabled="streaming || (currentStats?.documentCount ?? 0) === 0"
                @click="onGenerateSamples"
              >
                {{ currentKb.sampleQuestions && currentKb.sampleQuestions.length > 0 ? '重新生成' : '生成示例问题' }}
              </el-button>
            </div>
            <div class="sample-chips" v-if="currentKb.sampleQuestions && currentKb.sampleQuestions.length > 0">
              <button
                v-for="(q, i) in currentKb.sampleQuestions"
                :key="i"
                class="sample-chip"
                :disabled="streaming"
                @click="onPickSample(q)"
              >
                {{ q }}
              </button>
            </div>
            <p class="sample-empty" v-else>
              尚无示例问题，点击上方按钮基于文档生成
            </p>
          </div>
          <div class="welcome-tips">
            <div class="tip">
              <el-icon><Document /></el-icon>
              <span>提问后系统先检索相关文档片段，再让 LLM 基于片段回答</span>
            </div>
            <div class="tip">
              <el-icon><ChatLineRound /></el-icon>
              <span>回答中的 [1][2] 标注可点击查看引用来源</span>
            </div>
          </div>
        </div>

        <!-- 消息列表 -->
        <div
          v-for="(msg, idx) in messages"
          :key="idx"
          class="msg-row"
          :class="msg.role"
        >
          <!-- 用户消息 -->
          <div v-if="msg.role === 'user'" class="msg-bubble user-bubble">
            <div class="msg-content">{{ msg.content }}</div>
          </div>

          <!-- assistant 消息 -->
          <div v-else class="msg-bubble assistant-bubble">
            <!-- 思考链（折叠/展开） -->
            <div
              v-if="msg.reasoning"
              class="reasoning-block"
              :class="{ expanded: reasoningExpanded[idx] }"
            >
              <div class="reasoning-header" @click="toggleReasoning(idx)">
                <el-icon class="toggle-icon">
                  <ArrowRight v-if="!reasoningExpanded[idx]" />
                  <ArrowDown v-else />
                </el-icon>
                <span class="reasoning-label">
                  思考链
                  <span v-if="streaming && idx === streamingIdx" class="streaming-tag">生成中…</span>
                </span>
              </div>
              <div v-show="reasoningExpanded[idx]" class="reasoning-content">
                {{ msg.reasoning }}
              </div>
            </div>

            <!-- 引用列表（折叠/展开，流结束后展示） -->
            <div
              v-if="msg.refs && msg.refs.length > 0 && !streaming"
              class="refs-block"
              :class="{ expanded: refsExpanded[idx] }"
            >
              <div class="refs-header" @click="toggleRefs(idx)">
                <el-icon class="toggle-icon">
                  <ArrowRight v-if="!refsExpanded[idx]" />
                  <ArrowDown v-else />
                </el-icon>
                <span class="refs-label">
                  引用来源（{{ msg.refs.length }}）
                </span>
              </div>
              <div v-show="refsExpanded[idx]" class="refs-list">
                <div
                  v-for="ref in msg.refs"
                  :key="ref.refId"
                  class="ref-item"
                  :data-ref-item="`${idx}-${ref.refId}`"
                >
                  <div class="ref-head">
                    <span class="ref-num">[{{ ref.refId }}]</span>
                    <span class="ref-title" :title="ref.documentTitle">
                      <el-icon><Document /></el-icon>
                      {{ ref.documentTitle }}
                    </span>
                    <el-tag :type="hitByTag(ref.hitBy)" size="small" effect="light">
                      {{ hitByLabel(ref.hitBy) }}
                    </el-tag>
                    <span class="ref-score" :title="`RRF score = ${formatScore(ref.score)}`">
                      {{ formatScore(ref.score) }}
                    </span>
                  </div>
                  <div v-if="ref.headingPath" class="ref-path">
                    章节：{{ ref.headingPath }}
                  </div>
                  <div class="ref-snippet">{{ ref.snippet }}</div>
                  <div class="ref-actions">
                    <el-link
                      type="primary"
                      :underline="false"
                      size="small"
                      @click="openChunkPreview(ref)"
                    >
                      查看全文
                    </el-link>
                  </div>
                </div>
              </div>
            </div>

            <!-- 正文 -->
            <div
              class="msg-content answer-content"
              :class="{ fallback: msg.isFallback }"
              @click="onAnswerClick"
              @mouseover="onAnswerMouseEnter"
              @mouseout="onAnswerMouseLeave"
              v-html="renderAnswer(msg.content, idx, msg.refs)"
            />

            <!-- 流式光标 -->
            <span v-if="streaming && idx === streamingIdx && msg.status === 'streaming'" class="stream-cursor">
              ▋
            </span>

            <!-- 降级标注 -->
            <el-alert
              v-if="msg.isFallback && msg.status === 'done'"
              title="相关度较低，仅供参考"
              type="warning"
              :closable="false"
              show-icon
              class="fallback-alert"
            />

            <!-- 中断标注 -->
            <div v-if="msg.cancelled" class="status-tag cancelled-tag">
              <el-icon><CircleClose /></el-icon>
              <span>已停止</span>
            </div>

            <!-- 错误提示 -->
            <el-alert
              v-if="msg.error"
              :title="msg.error"
              type="error"
              :closable="false"
              show-icon
              class="error-alert"
            />

            <!-- P9 候选 3：置信度徽章 + 反馈按钮（done 状态才显示） -->
            <div
              v-if="msg.status === 'done' && (confidenceMeta(msg.confidence) || msg.messageId)"
              class="msg-footer"
            >
              <span
                v-if="confidenceMeta(msg.confidence)"
                class="confidence-badge"
                :class="confidenceMeta(msg.confidence)!.cls"
              >
                {{ confidenceMeta(msg.confidence)!.text }}
              </span>
              <template v-if="msg.messageId && currentKb">
                <span class="footer-divider">·</span>
                <button
                  class="feedback-btn"
                  :class="{ active: msg.feedbackRating === 1 }"
                  :disabled="msg.feedbackSubmitted && msg.feedbackRating !== 1"
                  :title="msg.feedbackRating === 1 ? '已点赞' : '点赞'"
                  @click="onSubmitFeedback(idx, 1)"
                >
                  <el-icon><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 21h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 8.59C7.22 8.95 7 9.45 7 10v9c0 1.1.9 2 2 2zM1 10h4v11H1z"/></svg></el-icon>
                </button>
                <button
                  class="feedback-btn"
                  :class="{ active: msg.feedbackRating === -1 }"
                  :disabled="msg.feedbackSubmitted && msg.feedbackRating !== -1"
                  :title="msg.feedbackRating === -1 ? '已点踩' : '点踩'"
                  @click="onSubmitFeedback(idx, -1)"
                >
                  <el-icon><svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59C16.78 16.05 17 15.55 17 15V6c0-1.1-.9-2-2-2zM23 6h-4v11h4z"/></svg></el-icon>
                </button>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- P9 候选 3：点踩理由弹窗 -->
      <el-dialog
        v-model="feedbackDialogVisible"
        title="反馈不满意原因"
        width="500"
        :close-on-click-modal="false"
      >
        <el-input
          v-model="feedbackDialogReason"
          type="textarea"
          :rows="4"
          maxlength="500"
          show-word-limit
          placeholder="请描述这条回答的问题，帮我们改进检索质量"
          @keydown.enter.exact.prevent="onConfirmFeedback"
        />
        <template #footer>
          <el-button @click="feedbackDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="feedbackDialogLoading" @click="onConfirmFeedback">
            提交
          </el-button>
        </template>
      </el-dialog>

      <!-- 输入区 -->
      <div class="input-area">
        <!-- F6 文档选择器：限定检索范围 -->
        <div v-if="currentKb && kbDocuments.length > 0" class="doc-selector-row">
          <el-select
            v-model="selectedDocIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            :max-collapse-tags="2"
            placeholder="检索范围：全部文档"
            size="small"
            style="width: 360px"
            :disabled="streaming"
          >
            <el-option
              v-for="doc in kbDocuments"
              :key="doc.documentId"
              :label="doc.title"
              :value="doc.documentId"
            >
              <span style="float: left">{{ doc.title }}</span>
              <span style="float: right; color: var(--el-text-color-secondary); font-size: 12px;">
                {{ doc.format }} · {{ doc.chunkCount }}块
              </span>
            </el-option>
          </el-select>
          <el-button
            v-if="selectedDocIds.length > 0"
            text
            size="small"
            @click="selectedDocIds = []"
            :disabled="streaming"
          >
            清空选择
          </el-button>
        </div>
        <div class="input-row">
          <el-input
            v-model="inputQuery"
            type="textarea"
            :rows="2"
            :autosize="{ minRows: 2, maxRows: 6 }"
            placeholder="输入问题，回车发送…（Shift+Enter 换行）"
            :disabled="streaming"
            @keydown.enter.exact.prevent="sendQuery"
            @keydown.shift.enter.exact
          />
          <el-button
            v-if="!streaming"
            type="primary"
            :icon="Promotion"
            :disabled="!inputQuery.trim() || !currentKb"
            @click="sendQuery"
          >
            发送
          </el-button>
          <el-button
            v-else
            type="danger"
            :icon="CircleClose"
            @click="stopStream"
          >
            停止
          </el-button>
        </div>
        <div class="input-hint">
          <span v-if="currentKb">
            当前知识库：{{ currentKb.name }}
            <template v-if="selectedDocIds.length > 0">
              · 限定 {{ selectedDocIds.length }} 个文档
            </template>
          </span>
          <span v-else>请先选择知识库</span>
        </div>
      </div>
    </main>

    <!-- P9 候选 1：引用悬浮卡（hover pill 时显示 chunk 预览） -->
    <Teleport to="body">
      <div
        v-if="citationPopoverVisible"
        class="citation-popover"
        :style="{ left: `${citationPopoverPos.x}px`, top: `${citationPopoverPos.y}px` }"
        @mouseenter="onPopoverEnter"
        @mouseleave="onPopoverLeave"
      >
        <div class="popover-header">
          <el-icon><Document /></el-icon>
          <span class="popover-title" :title="citationPopoverTitle">{{ citationPopoverTitle }}</span>
        </div>
        <div v-if="citationPopoverLoading" class="popover-loading">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>加载中…</span>
        </div>
        <div v-else-if="citationPopoverData" class="popover-content">
          <div v-if="citationPopoverData.headingPath" class="popover-path">
            章节：{{ citationPopoverData.headingPath }}
          </div>
          <div class="popover-snippet">{{ citationPopoverData.content.slice(0, 240) }}{{ citationPopoverData.content.length > 240 ? '…' : '' }}</div>
          <el-link type="primary" :underline="false" size="small" class="popover-view-full" @click="onPopoverViewFull">
            查看全文
          </el-link>
        </div>
        <div v-else class="popover-empty">无法加载引用内容</div>
      </div>
    </Teleport>

    <!-- F4 引用预览弹窗 -->
    <el-dialog
      v-model="chunkPreviewVisible"
      :title="`引用全文 - ${chunkPreviewDocTitle}`"
      width="720px"
      top="8vh"
      class="chunk-preview-dialog"
    >
      <div v-loading="chunkPreviewLoading" class="chunk-preview-body">
        <template v-if="chunkPreviewData">
          <div class="chunk-preview-meta">
            <el-tag size="small" effect="plain">
              chunk #{{ chunkPreviewData.chunkIndex }}
            </el-tag>
            <el-tag v-if="chunkPreviewData.headingPath" size="small" effect="plain" type="info">
              {{ chunkPreviewData.headingPath }}
            </el-tag>
          </div>
          <pre class="chunk-preview-content">{{ chunkPreviewData.content }}</pre>
        </template>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.kb-ask-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--lx-bg);
}

/* ============ 顶部栏 ============ */
.ask-header {
  display: flex;
  align-items: center;
  gap: var(--lx-space-3);
  padding: var(--lx-space-3) var(--lx-space-5);
  background: var(--lx-bg-elevated);
  border-bottom: 1px solid var(--lx-border);
  flex-shrink: 0;
  height: 56px;
}
.kb-title-block {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  flex: 1;
  min-width: 0;
}
.kb-title-icon {
  color: var(--lx-primary);
  font-size: 22px;
  flex-shrink: 0;
}
.kb-title-text {
  min-width: 0;
  flex: 1;
}
.kb-title-name {
  font-size: var(--lx-font-md);
  font-weight: var(--lx-font-semibold);
  color: var(--lx-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-title-meta {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
}
.ask-actions {
  flex-shrink: 0;
}

/* ============ 空状态 ============ */
.kb-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ============ 聊天主区 ============ */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.chat-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--lx-space-5);
  display: flex;
  flex-direction: column;
  gap: var(--lx-space-4);
}

/* 欢迎页 */
.welcome {
  margin: auto;
  text-align: center;
  max-width: 560px;
  padding: var(--lx-space-8) var(--lx-space-5);
}
.welcome-icon {
  width: 88px;
  height: 88px;
  margin: 0 auto var(--lx-space-4);
  border-radius: 50%;
  background: var(--lx-gradient-primary);
  color: var(--lx-text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--lx-shadow-primary);
}
.welcome h2 {
  margin: 0 0 var(--lx-space-2);
  font-size: var(--lx-font-2xl);
  color: var(--lx-text);
}
.welcome-desc {
  color: var(--lx-text-secondary);
  margin: 0 0 var(--lx-space-6);
}
.welcome-tips {
  display: flex;
  flex-direction: column;
  gap: var(--lx-space-3);
  text-align: left;
}
.welcome-tips .tip {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  padding: var(--lx-space-3) var(--lx-space-4);
  background: var(--lx-bg-elevated);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-md);
  color: var(--lx-text-regular);
  font-size: var(--lx-font-sm);
}
.welcome-tips .tip .el-icon {
  color: var(--lx-primary);
  flex-shrink: 0;
}

/* ============ R4 示例问题 ============ */
.sample-questions {
  margin: 0 0 var(--lx-space-6);
  text-align: left;
}
.sample-questions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--lx-space-2);
}
.sample-questions-header .sq-title {
  font-size: var(--lx-font-sm);
  color: var(--lx-text-secondary);
  font-weight: 500;
}
.sample-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--lx-space-2);
}
.sample-chip {
  appearance: none;
  -webkit-appearance: none;
  border: 1px solid var(--lx-border);
  background: var(--lx-bg-elevated);
  color: var(--lx-text-regular);
  padding: var(--lx-space-2) var(--lx-space-3);
  border-radius: var(--lx-radius-md);
  font-size: var(--lx-font-sm);
  line-height: 1.5;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.sample-chip:hover:not(:disabled) {
  border-color: var(--lx-primary);
  color: var(--lx-primary);
  background: var(--lx-primary-bg);
}
.sample-chip:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.sample-empty {
  margin: var(--lx-space-3) 0 0;
  font-size: var(--lx-font-sm);
  color: var(--lx-text-placeholder);
}

/* ============ 消息行 ============ */
.msg-row {
  display: flex;
  max-width: 960px;
  width: 100%;
  margin: 0 auto;
}
.msg-row.user {
  justify-content: flex-end;
}
.msg-row.assistant {
  justify-content: flex-start;
}
.msg-bubble {
  max-width: 85%;
  padding: var(--lx-space-3) var(--lx-space-4);
  border-radius: var(--lx-radius-lg);
  position: relative;
}
.user-bubble {
  background: var(--lx-gradient-primary);
  color: var(--lx-text-inverse);
  border-bottom-right-radius: var(--lx-radius-sm);
}
.assistant-bubble {
  background: var(--lx-bg-elevated);
  border: 1px solid var(--lx-border);
  color: var(--lx-text);
  border-bottom-left-radius: var(--lx-radius-sm);
  box-shadow: var(--lx-shadow-sm);
  max-width: 88%;
}
.msg-content {
  font-size: var(--lx-font-base);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.user-bubble .msg-content {
  white-space: pre-wrap;
}

/* ============ 思考链 ============ */
.reasoning-block {
  margin-bottom: var(--lx-space-3);
  border: 1px dashed var(--lx-border-strong);
  border-radius: var(--lx-radius-md);
  background: var(--lx-bg-subtle);
  overflow: hidden;
}
.reasoning-header {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  padding: var(--lx-space-2) var(--lx-space-3);
  cursor: pointer;
  font-size: var(--lx-font-sm);
  color: var(--lx-text-secondary);
  user-select: none;
  transition: background var(--lx-transition-fast);
}
.reasoning-header:hover {
  background: var(--lx-bg-muted);
}
.toggle-icon {
  font-size: 12px;
  transition: transform var(--lx-transition-fast);
}
.reasoning-label {
  font-weight: var(--lx-font-semibold);
}
.streaming-tag {
  margin-left: var(--lx-space-2);
  color: var(--lx-primary);
  font-weight: var(--lx-font-normal);
  font-size: var(--lx-font-xs);
}
.reasoning-content {
  padding: var(--lx-space-3);
  font-size: var(--lx-font-sm);
  color: var(--lx-text-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
  border-top: 1px solid var(--lx-border);
  max-height: 240px;
  overflow-y: auto;
}

/* ============ 引用列表 ============ */
.refs-block {
  margin-bottom: var(--lx-space-3);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-md);
  background: var(--lx-primary-50);
  overflow: hidden;
}
.refs-header {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  padding: var(--lx-space-2) var(--lx-space-3);
  cursor: pointer;
  font-size: var(--lx-font-sm);
  color: var(--lx-primary-700);
  user-select: none;
  background: var(--lx-primary-100);
  transition: background var(--lx-transition-fast);
}
.refs-header:hover {
  background: var(--lx-primary-100);
  filter: brightness(0.97);
}
.refs-label {
  font-weight: var(--lx-font-semibold);
}
.refs-list {
  padding: var(--lx-space-2) var(--lx-space-3) var(--lx-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--lx-space-2);
  max-height: 320px;
  overflow-y: auto;
}
.ref-item {
  padding: var(--lx-space-2) var(--lx-space-3);
  background: var(--lx-bg-elevated);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-sm);
  font-size: var(--lx-font-sm);
  transition: all var(--lx-transition-fast);
}
.ref-item.ref-highlight {
  border-color: var(--lx-primary);
  box-shadow: 0 0 0 2px var(--lx-primary-100);
}
.ref-head {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  margin-bottom: 4px;
}
.ref-num {
  font-weight: var(--lx-font-bold);
  color: var(--lx-primary);
  font-size: var(--lx-font-sm);
  flex-shrink: 0;
}
.ref-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--lx-text);
  font-weight: var(--lx-font-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ref-title .el-icon {
  color: var(--lx-text-placeholder);
  flex-shrink: 0;
}
.ref-score {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
  font-family: monospace;
  flex-shrink: 0;
}
.ref-path {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-secondary);
  margin-bottom: 4px;
}
.ref-snippet {
  font-size: var(--lx-font-xs);
  color: var(--lx-text-regular);
  line-height: 1.5;
  max-height: 4.5em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.ref-actions {
  margin-top: 6px;
  text-align: right;
}

/* ============ F4 引用预览弹窗 ============ */
.chunk-preview-body {
  min-height: 200px;
  max-height: 70vh;
  overflow-y: auto;
}

.chunk-preview-meta {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.chunk-preview-content {
  font-family: var(--lx-font-mono, 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace);
  font-size: 13px;
  line-height: 1.6;
  color: var(--lx-text-primary, #303133);
  background: var(--lx-bg-light, #f5f7fa);
  padding: 16px;
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

/* ============ 回答正文 ============ */
.answer-content {
  white-space: normal;
}
.answer-content.fallback {
  border-left: 3px solid var(--lx-warning);
  padding-left: var(--lx-space-3);
}
.answer-content :deep(p) {
  margin: 0 0 var(--lx-space-2);
}
.answer-content :deep(p:last-child) {
  margin-bottom: 0;
}
.answer-content :deep(pre) {
  background: var(--lx-bg-subtle);
  padding: var(--lx-space-3);
  border-radius: var(--lx-radius-sm);
  overflow-x: auto;
  font-size: var(--lx-font-sm);
  margin: var(--lx-space-2) 0;
}
.answer-content :deep(code) {
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.95em;
}
.answer-content :deep(.rag-ref-tag) {
  color: var(--lx-primary);
  cursor: pointer;
  font-weight: var(--lx-font-semibold);
  padding: 0 2px;
  transition: color var(--lx-transition-fast);
}
.answer-content :deep(.rag-ref-tag:hover) {
  color: var(--lx-primary-700);
  text-decoration: underline;
}
/* ============ P9 候选 1：引用 pill 样式 ============ */
.answer-content :deep(.rag-ref-pill) {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  margin: 0 2px;
  border-radius: 999px;
  background: var(--lx-primary-bg, #e3f2fd);
  border: 1px solid var(--lx-primary-100, #bbdefb);
  color: var(--lx-primary, #1976d2);
  font-size: 0.85em;
  line-height: 1.4;
  cursor: pointer;
  vertical-align: baseline;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  user-select: none;
}
.answer-content :deep(.rag-ref-pill:hover) {
  background: var(--lx-primary, #1976d2);
  color: #fff;
  border-color: var(--lx-primary, #1976d2);
}
.answer-content :deep(.rag-ref-pill .pill-icon) {
  font-size: 0.95em;
  line-height: 1;
}
.answer-content :deep(.rag-ref-pill .pill-text) {
  max-width: 12em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.answer-content :deep(.rag-ref-pill .pill-num) {
  font-size: 0.85em;
  opacity: 0.75;
  margin-left: 1px;
}
.answer-content :deep(.rag-ref-pill:hover .pill-num) {
  opacity: 0.9;
}
.stream-cursor {
  display: inline-block;
  color: var(--lx-primary);
  animation: blink 1s steps(2, start) infinite;
  margin-left: 2px;
}
@keyframes blink {
  to { visibility: hidden; }
}
.fallback-alert {
  margin-top: var(--lx-space-2);
}
.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: var(--lx-space-2);
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
}
.cancelled-tag .el-icon {
  color: var(--lx-danger);
}
.error-alert {
  margin-top: var(--lx-space-2);
}

/* ============ P9 候选 3：消息底部置信度 + 反馈 ============ */
.msg-footer {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  margin-top: var(--lx-space-3);
  padding-top: var(--lx-space-2);
  border-top: 1px dashed var(--lx-border);
}
.confidence-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
}
.confidence-high {
  background: var(--lx-success-bg, #e8f5e9);
  color: var(--lx-success, #2e7d32);
}
.confidence-medium {
  background: var(--lx-primary-bg, #e3f2fd);
  color: var(--lx-primary, #1976d2);
}
.confidence-low {
  background: var(--lx-warning-bg, #fff8e1);
  color: var(--lx-warning, #f57c00);
}
.confidence-none {
  background: var(--lx-bg-secondary, #f5f5f5);
  color: var(--lx-text-secondary, #757575);
}
.footer-divider {
  color: var(--lx-text-placeholder, #bdbdbd);
  font-size: 12px;
}
.feedback-btn {
  appearance: none;
  -webkit-appearance: none;
  border: none;
  background: transparent;
  padding: 4px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--lx-text-secondary);
  display: inline-flex;
  align-items: center;
  transition: color 0.15s, background 0.15s;
}
.feedback-btn:hover:not(:disabled) {
  background: var(--lx-bg-secondary, #f5f5f5);
  color: var(--lx-primary);
}
.feedback-btn.active {
  color: var(--lx-primary);
}
.feedback-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.feedback-btn .el-icon {
  font-size: 16px;
}
.feedback-btn.active .el-icon svg {
  filter: drop-shadow(0 0 2px currentColor);
}

/* ============ 输入区 ============ */
.input-area {
  border-top: 1px solid var(--lx-border);
  background: var(--lx-bg-elevated);
  padding: var(--lx-space-3) var(--lx-space-5);
  flex-shrink: 0;
}
.doc-selector-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.input-row {
  display: flex;
  gap: var(--lx-space-3);
  max-width: 960px;
  margin: 0 auto;
  align-items: flex-end;
}
.input-row .el-input {
  flex: 1;
}
.input-hint {
  text-align: center;
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
  margin-top: var(--lx-space-2);
  max-width: 960px;
  margin-left: auto;
  margin-right: auto;
}

/* ============ 空提示 ============ */
.kb-empty {
  flex: 1;
}

/* ============ P9 候选 1：引用悬浮卡 ============ */
.citation-popover {
  position: absolute;
  z-index: 2050;
  width: 360px;
  max-width: 90vw;
  background: var(--lx-bg-elevated, #fff);
  border: 1px solid var(--lx-border, #e0e0e0);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  overflow: hidden;
}
.popover-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--lx-border, #e0e0e0);
  font-size: 13px;
  font-weight: 500;
  color: var(--lx-text, #333);
}
.popover-header .el-icon {
  color: var(--lx-primary);
  flex-shrink: 0;
}
.popover-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.popover-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px;
  font-size: 12px;
  color: var(--lx-text-secondary, #757575);
}
.popover-content {
  padding: 10px 12px;
}
.popover-path {
  font-size: 12px;
  color: var(--lx-text-secondary, #757575);
  margin-bottom: 6px;
}
.popover-snippet {
  font-size: 13px;
  line-height: 1.6;
  color: var(--lx-text-regular, #555);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
  margin-bottom: 8px;
}
.popover-view-full {
  font-size: 12px;
}
.popover-empty {
  padding: 12px;
  font-size: 12px;
  color: var(--lx-text-placeholder, #9e9e9e);
  text-align: center;
}
</style>

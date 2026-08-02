<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowLeft, ArrowRight, ArrowDown, ChatLineRound, CircleClose, Document, Promotion } from '@element-plus/icons-vue';
import { marked } from 'marked';
import { getKb, getKbStats, listKbs, askStream, type KnowledgeBase, type KbStats, type RagEvent, type RagReference } from '@/api/kb';
import { useAuthStore } from '@/stores/auth';
import { sanitizeMarkedHtml } from '@/utils/sanitize';

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
    const [kb, stats] = await Promise.all([
      getKb(id),
      getKbStats(id).catch(() => null),
    ]);
    currentKb.value = kb;
    currentStats.value = stats;
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
  if (!currentKb.value) {
    ElMessage.warning('请先选择知识库');
    return;
  }

  // 重置输入
  inputQuery.value = '';

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

  try {
    for await (const evt of askStream(currentKb.value.id, q, abortController.signal)) {
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
      msg.reasoning = (msg.reasoning ?? '') + evt.content;
      break;
    case 'delta':
      msg.content += evt.content;
      break;
    case 'done':
      msg.content = evt.answer; // 用后端最终 answer 校正（与 delta 拼接应一致）
      msg.isFallback = evt.isFallback;
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

// ============ UI 辅助 ============

async function scrollToBottom() {
  await nextTick();
  const el = chatScrollRef.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
}

/**
 * 渲染 markdown 为安全 HTML
 * 引用标注 [1][2] 转为可点击的上标链接
 */
function renderAnswer(md: string, msgIdx: number): string {
  if (!md) return '';
  // 先把 [1] [1,2] [1][2] 形式转成占位符避免被 markdown 解析
  // 然后渲染 markdown，最后把占位符替换为上标链接
  const placeholder = (n: string) => `@@REF_${n}@@`;
  const refPattern = /(\[(\d+(?:[,\s\d]*)\])/g;
  const tokens: string[] = [];
  const preprocessed = md.replace(refPattern, (m, p1: string) => {
    tokens.push(p1);
    return placeholder(String(tokens.length - 1));
  });
  const html = marked.parse(preprocessed, { async: false }) as string;
  const safe = sanitizeMarkedHtml(html);
  // 把占位符替换为上标链接
  return safe.replace(/@@REF_(\d+)@@/g, (_, i: string) => {
    const token = tokens[Number(i)];
    // 提取 [1,2] 中的数字列表
    const nums = token.replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
    const links = nums.map((n) => {
      return `<sup class="rag-ref-tag" data-ref="${n}" data-msg="${msgIdx}">[${n}]</sup>`;
    });
    return links.join('');
  });
}

/**
 * 点击引用上标：滚动到引用列表并高亮
 */
function onAnswerClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target?.classList?.contains('rag-ref-tag')) {
    const refId = Number(target.dataset.ref);
    const msgIdx = Number(target.dataset.msg);
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
}

function toggleRefs(idx: number) {
  refsExpanded.value[idx] = !refsExpanded.value[idx];
}

function toggleReasoning(idx: number) {
  reasoningExpanded.value[idx] = !reasoningExpanded.value[idx];
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
                </div>
              </div>
            </div>

            <!-- 正文 -->
            <div
              class="msg-content answer-content"
              :class="{ fallback: msg.isFallback }"
              @click="onAnswerClick"
              v-html="renderAnswer(msg.content, idx)"
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
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="input-area">
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
          <span v-if="currentKb">当前知识库：{{ currentKb.name }}</span>
          <span v-else>请先选择知识库</span>
        </div>
      </div>
    </main>
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

/* ============ 输入区 ============ */
.input-area {
  border-top: 1px solid var(--lx-border);
  background: var(--lx-bg-elevated);
  padding: var(--lx-space-3) var(--lx-space-5);
  flex-shrink: 0;
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
</style>

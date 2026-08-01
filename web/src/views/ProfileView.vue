<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import {
  getMyLlmConfig,
  updateMyLlmConfig,
  listActAsCandidates,
  type MyLlmConfig,
  type ActAsCandidate,
} from '@/api/llm-config';

/**
 * 个人设置页（所有登录用户）
 * 用户配置自己的 LLM（baseUrl/apiKey/model/enableThinking）用于 AI 总结/知识库生成。
 * 普通用户必须自己配置才能使用 AI（不提供全局默认）。
 * admin 可设置"代理身份"，调用 AI 时使用指定用户的配置（方便测试）；
 * admin 未配个人 LLM 时回退系统配置 llm.*。
 */
const authStore = useAuthStore();
const loading = ref(false);
const saving = ref(false);

// 表单（apiKey 为 '******' 表示已配置但不修改，留空表示清空）
const form = reactive({
  baseUrl: '' as string,
  apiKey: '' as string,
  model: '' as string,
  enableThinking: true as boolean,
  actAsUserId: '' as string, // 空 = 不代理
});

// 原始值（用于检测是否有修改）
let original: { baseUrl: string; apiKey: string; model: string; enableThinking: boolean; actAsUserId: string } | null = null;

// apiKey 是否已配置（后端返回 '******'）
const apiKeyConfigured = ref(false);

// admin 代理身份候选
const candidates = ref<ActAsCandidate[]>([]);

const isAdmin = computed(() => authStore.isAdmin);

// 是否有未保存修改
const hasChanges = computed(() => {
  if (!original) return false;
  return (
    form.baseUrl !== original.baseUrl ||
    form.apiKey !== original.apiKey ||
    form.model !== original.model ||
    form.enableThinking !== original.enableThinking ||
    form.actAsUserId !== original.actAsUserId
  );
});

async function load() {
  loading.value = true;
  try {
    const [cfg, cand] = await Promise.all([
      getMyLlmConfig(),
      isAdmin.value ? listActAsCandidates().catch(() => [] as ActAsCandidate[]) : Promise.resolve([] as ActAsCandidate[]),
    ]);
    fillForm(cfg);
    candidates.value = cand;
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '加载失败');
  } finally {
    loading.value = false;
  }
}

function fillForm(cfg: MyLlmConfig) {
  form.baseUrl = cfg.baseUrl ?? '';
  form.model = cfg.model ?? '';
  form.enableThinking = cfg.enableThinking;
  form.actAsUserId = cfg.actAsUserId ?? '';
  // apiKey: 后端已配置返回 '******'，未配置返回 null
  if (cfg.apiKey === '******') {
    apiKeyConfigured.value = true;
    form.apiKey = '******'; // 显示占位，保存时若未改则跳过
  } else {
    apiKeyConfigured.value = false;
    form.apiKey = '';
  }
  original = {
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    model: form.model,
    enableThinking: form.enableThinking,
    actAsUserId: form.actAsUserId,
  };
}

function resetForm() {
  if (!original) return;
  form.baseUrl = original.baseUrl;
  form.apiKey = original.apiKey;
  form.model = original.model;
  form.enableThinking = original.enableThinking;
  form.actAsUserId = original.actAsUserId;
}

async function save() {
  if (!hasChanges.value) {
    ElMessage.info('无修改');
    return;
  }
  saving.value = true;
  try {
    const payload: Record<string, unknown> = {
      baseUrl: form.baseUrl || null,
      model: form.model || null,
      enableThinking: form.enableThinking,
    };
    // apiKey: '******'（未改）跳过；其他值（含空串清空）传入
    if (form.apiKey !== '******') {
      payload.apiKey = form.apiKey || null;
    }
    // 代理身份仅 admin
    if (isAdmin.value) {
      payload.actAsUserId = form.actAsUserId || null;
    }
    await updateMyLlmConfig(payload);
    ElMessage.success('已保存');
    await load(); // 重新加载回显
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? '保存失败');
  } finally {
    saving.value = false;
  }
}

// 候选用户显示名
function candidateLabel(c: ActAsCandidate): string {
  return `${c.username}（${c.email}）${c.role === 'admin' ? ' · 管理员' : ''}`;
}

onMounted(load);
</script>

<template>
  <div class="profile-view" v-loading="loading">
    <header class="page-header">
      <h1>个人设置</h1>
      <p class="subtitle">配置个人使用的 AI 大模型。普通用户需自行配置后才能使用 AI 总结与知识库生成。</p>
    </header>

    <section class="card">
      <h2 class="card-title">
        <el-icon><MagicStick /></el-icon> 我的 LLM 配置
      </h2>
      <p class="card-desc">
        填写自己的模型端点、API Key、模型名。保存后立即生效，用于 AI 总结与知识库生成。
        <template v-if="isAdmin">
          <br />管理员未填此项时回退「系统配置」中的 LLM 默认值。
        </template>
        <template v-else>
          <br /><strong>普通用户必须配置此项才能使用 AI 功能</strong>（系统不提供默认 API）。
        </template>
      </p>

      <el-form label-position="top" class="llm-form">
        <el-form-item label="Base URL（OpenAI 兼容端点）">
          <el-input
            v-model="form.baseUrl"
            placeholder="如 http://icp.rd.in.linx/v1/"
            clearable
          />
        </el-form-item>

        <el-form-item label="API Key">
          <el-input
            v-model="form.apiKey"
            type="password"
            show-password
            :placeholder="apiKeyConfigured ? '已配置（输入新值可替换，留空清除）' : '内网若无需鉴权可留空'"
            clearable
          />
        </el-form-item>

        <el-form-item label="模型名">
          <el-input
            v-model="form.model"
            placeholder="如 zai-org/GLM-5.2-FP8"
            clearable
          />
        </el-form-item>

        <el-form-item label="推理模式">
          <el-switch v-model="form.enableThinking" />
          <span class="hint">启用推理（GLM-5.2 等模型）；关闭可加速简单任务</span>
        </el-form-item>

        <!-- admin 代理身份 -->
        <el-form-item v-if="isAdmin" label="代理身份（可选）">
          <el-select
            v-model="form.actAsUserId"
            placeholder="不代理（使用自己的配置）"
            clearable
            filterable
            class="act-as-select"
          >
            <el-option
              v-for="c in candidates"
              :key="c.id"
              :label="candidateLabel(c)"
              :value="c.id"
            />
          </el-select>
          <div class="hint">
            设置后，你调用 AI 时实际使用该用户的 LLM 配置（方便测试不同用户的配置是否可用）。
            不设置时使用你自己的配置或系统默认。
          </div>
        </el-form-item>
      </el-form>

      <div class="actions">
        <el-button v-if="hasChanges" @click="resetForm">撤销</el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="!hasChanges"
          @click="save"
        >
          保存配置
        </el-button>
        <el-tag v-if="hasChanges" type="warning" size="small" effect="plain" class="change-tag">
          有未保存修改
        </el-tag>
      </div>
    </section>
  </div>
</template>

<style scoped>
.profile-view {
  padding: var(--lx-space-6);
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  max-width: 720px;
  margin: 0 auto;
}
.page-header h1 {
  margin: 0 0 var(--lx-space-1);
  font-size: var(--lx-font-2xl);
  font-weight: var(--lx-font-bold);
  color: var(--lx-text);
}
.subtitle {
  margin: 0 0 var(--lx-space-6);
  font-size: var(--lx-font-sm);
  color: var(--lx-text-secondary);
}
.card {
  background: var(--lx-bg-elevated);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-lg);
  padding: var(--lx-space-5) var(--lx-space-6);
  box-shadow: var(--lx-shadow-sm);
}
.card-title {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  font-size: var(--lx-font-lg);
  font-weight: var(--lx-font-semibold);
  color: var(--lx-text);
  margin: 0 0 var(--lx-space-2);
}
.card-desc {
  font-size: var(--lx-font-sm);
  color: var(--lx-text-secondary);
  margin: 0 0 var(--lx-space-5);
  line-height: 1.6;
}
.llm-form {
  max-width: 560px;
}
.act-as-select {
  width: 100%;
}
.hint {
  margin-left: var(--lx-space-2);
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
}
.actions {
  margin-top: var(--lx-space-5);
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
}
.change-tag {
  margin-left: var(--lx-space-2);
}
</style>

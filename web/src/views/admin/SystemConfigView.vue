<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  getSystemConfig,
  getEditableSettings,
  updateSystemConfig,
  type SystemConfig,
  type EditableSetting,
} from '@/api/system';

/**
 * 系统配置页
 * - 可改项（LLM 开关/端点/模型/超时、各服务开关、OCR、注册、上传大小）支持在线编辑，立即生效
 * - 只读项（服务 URL、JWT 密钥、端口、token 有效期）仅展示，修改需编辑 .env 后重启
 */
const config = ref<SystemConfig | null>(null);
const settings = ref<EditableSetting[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

// 编辑中的表单值：key -> 当前输入值
const form = ref<Record<string, string | undefined>>({});

// 归一化比较：undefined / null / "" 视为同值（空）
// 避免 el-input-number 把空字符串解析为 0 后触发"有未保存修改"误判
function norm(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  return String(v);
}

async function loadAll() {
  loading.value = true;
  error.value = null;
  try {
    const [cfg, sets] = await Promise.all([getSystemConfig(), getEditableSettings()]);
    config.value = cfg;
    settings.value = sets.editable;
    // 初始化表单：用后端返回的脱敏值填充
    // number 类型空值用 undefined，避免 el-input-number 把 "" 解析为 0 触发 hasChanges 误判
    form.value = {};
    for (const s of sets.editable) {
      const v = s.value ?? '';
      form.value[s.key] = s.type === 'number' && v === '' ? undefined : v;
    }
  } catch (err: any) {
    error.value = err?.response?.data?.message ?? err?.message ?? '加载配置失败';
  } finally {
    loading.value = false;
  }
}

// 按分组归类设置项
const groupedSettings = computed(() => {
  const map = new Map<string, EditableSetting[]>();
  for (const s of settings.value) {
    if (!map.has(s.group)) map.set(s.group, []);
    map.get(s.group)!.push(s);
  }
  return Array.from(map.entries());
});

// 检测是否有未保存的修改
// 用 norm() 归一化比较，避免 number 字段空值与 0 之间的类型差异导致误判
const hasChanges = computed(() => {
  return settings.value.some((s) => norm(form.value[s.key]) !== norm(s.value));
});

async function saveChanges() {
  if (!hasChanges.value) {
    ElMessage.info('无修改');
    return;
  }
  // 收集变化的项（与 hasChanges 保持同样的 norm() 比较口径，避免误判）
  const items: { key: string; value: string | null }[] = [];
  for (const s of settings.value) {
    const cur = norm(form.value[s.key]);
    const orig = norm(s.value);
    if (cur !== orig) {
      items.push({ key: s.key, value: cur === '' ? null : cur });
    }
  }
  if (items.length === 0) return;

  try {
    await ElMessageBox.confirm(
      `确认修改 ${items.length} 项配置？修改后立即生效，无需重启服务。`,
      '确认修改',
      { type: 'warning', confirmButtonText: '保存', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }

  saving.value = true;
  try {
    const res = await updateSystemConfig(items);
    if (res.updated.length > 0) {
      ElMessage.success(`已更新 ${res.updated.length} 项配置`);
    }
    if (res.skipped.length > 0) {
      ElMessage.warning(`跳过 ${res.skipped.length} 项：${res.skipped.join('; ')}`);
    }
    await loadAll(); // 重新加载反映最新值
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message ?? err?.message ?? '保存失败');
  } finally {
    saving.value = false;
  }
}

function resetForm() {
  for (const s of settings.value) {
    const v = s.value ?? '';
    form.value[s.key] = s.type === 'number' && v === '' ? undefined : v;
  }
}

onMounted(() => {
  loadAll();
});
</script>

<template>
  <div class="system-config" v-loading="loading">
    <header class="page-header">
      <div>
        <h1>系统配置</h1>
        <p class="subtitle">
          可改项支持在线编辑，立即生效；只读项（服务地址、JWT 密钥、端口等）修改需编辑 .env 后重启
        </p>
      </div>
      <div class="header-actions" v-if="hasChanges">
        <el-button @click="resetForm">撤销</el-button>
        <el-button type="primary" :loading="saving" @click="saveChanges">
          保存修改
        </el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="err" />

    <!-- 可在线修改的设置项 -->
    <section v-if="groupedSettings.length > 0" class="section">
      <h2 class="section-title">
        <el-icon><Setting /></el-icon>
        可修改配置
        <el-tag v-if="hasChanges" type="warning" size="small">有未保存修改</el-tag>
      </h2>
      <div class="editable-grid">
        <div v-for="[group, items] in groupedSettings" :key="group" class="edit-card">
          <div class="edit-head">{{ group }}</div>
          <div class="edit-body">
            <div v-for="s in items" :key="s.key" class="edit-row">
              <div class="edit-label">
                <span class="lbl">{{ s.label }}</span>
                <el-tag v-if="s.overridden" type="success" size="small" effect="plain">已自定义</el-tag>
              </div>
              <div class="edit-desc">{{ s.description }}</div>
              <!-- 布尔：开关 -->
              <el-switch
                v-if="s.type === 'boolean'"
                v-model="form[s.key]"
                active-value="true"
                inactive-value="false"
              />
              <!-- 数字 -->
              <el-input-number
                v-else-if="s.type === 'number'"
                v-model="form[s.key]"
                :min="1"
                :controls="false"
                size="small"
                class="num-input"
                :value-on-clear="undefined"
              />
              <!-- 字符串（敏感项显示 ******） -->
              <el-input
                v-else
                v-model="form[s.key]"
                size="small"
                :placeholder="s.value === '******' ? '已配置（输入新值可替换）' : '未配置'"
                :type="s.key === 'llm.apiKey' ? 'password' : 'text'"
                show-word-limit
              />
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 只读运行时配置 -->
    <section v-if="config" class="section">
      <h2 class="section-title">
        <el-icon><InfoFilled /></el-icon>
        运行时配置（只读）
      </h2>
      <div class="config-grid">
        <!-- LLM -->
        <div class="cfg-card">
          <div class="cfg-head">
            <el-icon class="cfg-icon"><MagicStick /></el-icon>
            <span class="cfg-name">LLM 大模型</span>
            <el-tag :type="config.llm.enabled ? 'success' : 'info'" size="small">
              {{ config.llm.enabled ? '已启用' : '未启用' }}
            </el-tag>
          </div>
          <dl class="cfg-body">
            <div><dt>向量模型</dt><dd>{{ config.llm.embedModel || '-' }}</dd></div>
            <div><dt>向量维度</dt><dd>{{ config.llm.embedDimensions || '-' }}</dd></div>
            <div><dt>重试次数</dt><dd>{{ config.llm.maxRetries }}</dd></div>
          </dl>
        </div>

        <!-- OnlyOffice -->
        <div class="cfg-card">
          <div class="cfg-head">
            <el-icon class="cfg-icon"><Edit /></el-icon>
            <span class="cfg-name">OnlyOffice 编辑器</span>
          </div>
          <dl class="cfg-body">
            <div><dt>内部地址</dt><dd>{{ config.onlyoffice.onlyofficeUrl || '-' }}</dd></div>
            <div><dt>公共地址</dt><dd>{{ config.onlyoffice.onlyofficePublicUrl || '-' }}</dd></div>
            <div><dt>回调地址</dt><dd>{{ config.onlyoffice.backendPublicUrl || '-' }}</dd></div>
            <div><dt>JWT 密钥</dt><dd>********</dd></div>
          </dl>
        </div>

        <!-- kkFileView -->
        <div class="cfg-card">
          <div class="cfg-head">
            <el-icon class="cfg-icon"><View /></el-icon>
            <span class="cfg-name">kkFileView 预览</span>
          </div>
          <dl class="cfg-body">
            <div><dt>内部地址</dt><dd>{{ config.kkfileview.internalUrl || '-' }}</dd></div>
            <div><dt>公共地址</dt><dd>{{ config.kkfileview.publicUrl || '-' }}</dd></div>
          </dl>
        </div>

        <!-- docling -->
        <div class="cfg-card">
          <div class="cfg-head">
            <el-icon class="cfg-icon"><Files /></el-icon>
            <span class="cfg-name">Docling 解析</span>
          </div>
          <dl class="cfg-body">
            <div><dt>端点</dt><dd>{{ config.docling.baseUrl || '-' }}</dd></div>
            <div><dt>超时</dt><dd>{{ config.docling.timeout }}ms</dd></div>
          </dl>
        </div>

        <!-- 认证 -->
        <div class="cfg-card">
          <div class="cfg-head">
            <el-icon class="cfg-icon"><Lock /></el-icon>
            <span class="cfg-name">认证 / 注册</span>
          </div>
          <dl class="cfg-body">
            <div><dt>Access 有效期</dt><dd>{{ config.auth.jwtAccessExpires }}</dd></div>
            <div><dt>Refresh 有效期</dt><dd>{{ config.auth.jwtRefreshExpires }}</dd></div>
            <div><dt>文件 token 有效期</dt><dd>{{ config.auth.fileTokenExpires }}</dd></div>
          </dl>
        </div>

        <!-- 上传 -->
        <div class="cfg-card">
          <div class="cfg-head">
            <el-icon class="cfg-icon"><Upload /></el-icon>
            <span class="cfg-name">上传限制</span>
          </div>
          <dl class="cfg-body">
            <div><dt>存储目录</dt><dd>{{ config.upload.uploadDir || '-' }}</dd></div>
            <div><dt>允许格式</dt><dd>{{ config.upload.allowedDocExtensions.join(', ') }}</dd></div>
            <div><dt>允许图片</dt><dd>{{ config.upload.allowedImageExtensions.join(', ') }}</dd></div>
          </dl>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.system-config {
  padding: 24px;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
}
.page-header h1 {
  margin: 0 0 4px;
  font-size: 22px;
  font-weight: 700;
  color: #1f2937;
}
.subtitle {
  margin: 0;
  font-size: 13px;
  color: #6b7280;
}
.header-actions {
  display: flex;
  gap: 8px;
}
.err {
  margin-bottom: 16px;
}
.section {
  margin-bottom: 24px;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 12px;
}
.editable-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 16px;
}
.edit-card {
  background: #fff;
  border: 1px solid #eef0f4;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}
.edit-head {
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  background: #f8fafc;
  border-bottom: 1px solid #eef0f4;
}
.edit-body {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.edit-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.edit-label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lbl {
  font-size: 13px;
  font-weight: 500;
  color: #374151;
}
.edit-desc {
  font-size: 12px;
  color: #9ca3af;
  line-height: 1.4;
}
.num-input {
  width: 160px;
}
.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 16px;
}
.cfg-card {
  background: #fff;
  border: 1px solid #eef0f4;
  border-radius: 12px;
  padding: 16px 18px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}
.cfg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f1f5;
}
.cfg-icon {
  font-size: 18px;
  color: #4f8cff;
}
.cfg-name {
  flex: 1;
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}
.cfg-body {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cfg-body > div {
  display: flex;
  font-size: 13px;
  line-height: 1.5;
}
.cfg-body dt {
  width: 110px;
  flex-shrink: 0;
  color: #9ca3af;
}
.cfg-body dd {
  margin: 0;
  flex: 1;
  color: #374151;
  word-break: break-all;
}
</style>

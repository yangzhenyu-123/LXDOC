<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  getKnowledgeTree,
  buildKnowledgeTree,
  type KnowledgeNode,
} from '@/api/knowledge';

// 向父组件抛出选中事件
const emit = defineEmits<{
  (e: 'select', payload: { type: 'doc' | 'dir'; id?: string; path?: string }): void;
}>();

const treeData = ref<KnowledgeNode[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

// el-tree 字段映射
const treeProps = {
  label: 'name',
  children: 'children',
};

/**
 * 加载 AI 知识库树
 */
async function loadTree() {
  loading.value = true;
  error.value = null;
  try {
    const docs = await getKnowledgeTree();
    treeData.value = buildKnowledgeTree(docs);
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? '加载知识库失败';
    error.value = msg;
    treeData.value = [];
  } finally {
    loading.value = false;
  }
}

/**
 * 节点点击：文档节点触发跳转，目录节点展开/折叠
 */
function handleNodeClick(node: KnowledgeNode) {
  if (node.type === 'doc' && node.docId) {
    emit('select', { type: 'doc', id: node.docId, path: node.path });
  }
}

/**
 * 刷新
 */
function refresh() {
  loadTree();
}

onMounted(() => {
  loadTree();
});
</script>

<template>
  <div class="knowledge-tree" v-loading="loading">
    <div v-if="error" class="kt-error">
      <el-alert :title="error" type="error" show-icon :closable="false" />
    </div>
    <el-empty
      v-else-if="!loading && treeData.length === 0"
      description="暂无 AI 总结文档"
      :image-size="64"
    />
    <el-tree
      v-else
      :data="treeData"
      :props="treeProps"
      node-key="path"
      default-expand-all
      :expand-on-click-node="false"
      @node-click="handleNodeClick"
    >
      <template #default="{ data }">
        <span class="kt-node" :class="{ 'is-doc': data.type === 'doc' }">
          <el-icon v-if="data.type === 'dir'" class="kt-icon dir"><Folder /></el-icon>
          <el-icon v-else class="kt-icon doc"><Document /></el-icon>
          <span class="kt-label">{{ data.name }}</span>
        </span>
      </template>
    </el-tree>
  </div>
</template>

<style scoped>
.knowledge-tree {
  min-height: 60px;
}
.kt-error {
  margin-bottom: 8px;
}
.kt-node {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: #4b5563;
}
.kt-node.is-doc {
  cursor: pointer;
}
.kt-node.is-doc:hover .kt-label {
  color: #4f8cff;
}
.kt-icon {
  font-size: 14px;
  flex-shrink: 0;
}
.kt-icon.dir {
  color: #f0a020;
}
.kt-icon.doc {
  color: #4f8cff;
}
.kt-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

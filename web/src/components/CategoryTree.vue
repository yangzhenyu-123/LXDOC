<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  createCategory,
  deleteCategory,
  getCategoriesTree,
  updateCategory,
  CategoryTypes,
  type Category,
} from '@/api/categories';

// 向父组件抛出选中事件
const emit = defineEmits<{
  (e: 'select', categoryId: string): void;
}>();

const treeData = ref<Category[]>([]);

// 右键菜单状态
const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  node: null as Category | null,
});

// 新建子分类对话框状态
const createDialog = reactive({
  visible: false,
  parentId: '' as string | null,
  name: '',
});

// 新建顶层分类对话框状态
const createTopDialog = reactive({
  visible: false,
  name: '',
  type: '',
  sort: 0,
});

// 已知类型选项（用于建议/下拉）
const knownTypes = computed(() => Object.values(CategoryTypes));

// 分类类型 → 前缀图标名（与 HomeView 风格一致，用于 el-tree 节点）
const typeIconMap: Record<string, string> = {
  tech_doc: 'Files',
  solution: 'MagicStick',
  bug_report: 'Warning',
  regulation: 'Document',
  dept_public: 'OfficeBuilding',
  key_project: 'Flag',
  os_knowledge: 'Monitor',
  training: 'Reading',
  eng_issues: 'Tools',
  key_bug: 'CircleClose',
  newcomer: 'User',
};
const defaultIcon = 'Folder';

// 节点图标：根据 type 返回对应图标名
function nodeIcon(type: string | null | undefined): string {
  return type ? typeIconMap[type] ?? defaultIcon : defaultIcon;
}

// 重命名对话框状态
const renameDialog = reactive({
  visible: false,
  id: '',
  name: '',
});

// el-tree 字段映射
const treeProps = {
  label: 'name',
  children: 'children',
};

// 加载分类树
async function loadTree() {
  try {
    const data = await getCategoriesTree();
    treeData.value = data ?? [];
  } catch (err: any) {
    ElMessage.error(`加载分类失败：${err?.message ?? '未知错误'}`);
  }
}

onMounted(() => {
  loadTree();
});

// 隐藏右键菜单
function hideContextMenu() {
  contextMenu.visible = false;
  contextMenu.node = null;
}

// 节点右键事件：弹出菜单
function onNodeContextmenu(
  event: MouseEvent,
  _node: unknown,
  data: Category,
) {
  event.preventDefault();
  contextMenu.node = data;
  contextMenu.x = event.clientX;
  contextMenu.y = event.clientY;
  contextMenu.visible = true;
  // 下一次点击时自动关闭菜单
  document.addEventListener('click', hideContextMenu, { once: true });
}

// 打开新建子分类对话框
function openCreateDialog() {
  if (!contextMenu.node) return;
  createDialog.parentId = contextMenu.node.id;
  createDialog.name = '';
  createDialog.visible = true;
  hideContextMenu();
}

// 提交新建子分类
async function submitCreate() {
  const name = createDialog.name.trim();
  if (!name) {
    ElMessage.warning('请输入分类名称');
    return;
  }
  try {
    await createCategory({ parentId: createDialog.parentId, name });
    ElMessage.success('创建成功');
    createDialog.visible = false;
    await loadTree();
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? '未知错误';
    ElMessage.error(`创建失败：${msg}`);
  }
}

// 打开新建顶层分类对话框
function openCreateTopDialog() {
  createTopDialog.name = '';
  createTopDialog.type = '';
  createTopDialog.sort = 0;
  createTopDialog.visible = true;
}

// 提交新建顶层分类
async function submitCreateTop() {
  const name = createTopDialog.name.trim();
  const type = createTopDialog.type.trim();
  if (!name) {
    ElMessage.warning('请输入分类名称');
    return;
  }
  if (!type) {
    ElMessage.warning('请输入分类类型标识（如 tech_doc / regulation）');
    return;
  }
  try {
    await createCategory({ parentId: null, name, type, sort: createTopDialog.sort || 0 });
    ElMessage.success('创建成功');
    createTopDialog.visible = false;
    await loadTree();
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? '未知错误';
    ElMessage.error(`创建失败：${msg}`);
  }
}

// 打开重命名对话框
function openRenameDialog() {
  if (!contextMenu.node) return;
  renameDialog.id = contextMenu.node.id;
  renameDialog.name = contextMenu.node.name;
  renameDialog.visible = true;
  hideContextMenu();
}

// 提交重命名
async function submitRename() {
  const name = renameDialog.name.trim();
  if (!name) {
    ElMessage.warning('请输入分类名称');
    return;
  }
  try {
    await updateCategory(renameDialog.id, { name });
    ElMessage.success('重命名成功');
    renameDialog.visible = false;
    await loadTree();
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? '未知错误';
    ElMessage.error(`重命名失败：${msg}`);
  }
}

// 删除分类（带确认弹窗，捕获 400 显示后端拒绝原因）
async function confirmDelete() {
  if (!contextMenu.node) return;
  const target = contextMenu.node;
  hideContextMenu();
  try {
    await ElMessageBox.confirm(
      `确定删除分类「${target.name}」吗？`,
      '删除确认',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
  } catch {
    // 用户点击取消
    return;
  }
  try {
    await deleteCategory(target.id);
    ElMessage.success('删除成功');
    await loadTree();
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? '未知错误';
    ElMessage.error(`删除失败：${msg}`);
  }
}

// 点击节点：抛出 select 事件
function onNodeClick(data: Category) {
  emit('select', data.id);
}
</script>

<template>
  <div class="category-tree">
    <div class="tree-toolbar">
      <el-button size="small" type="primary" @click="openCreateTopDialog">
        <el-icon><Plus /></el-icon> 新建顶层分类
      </el-button>
    </div>
    <el-tree
      :data="treeData"
      :props="treeProps"
      node-key="id"
      highlight-current
      default-expand-all
      @node-contextmenu="onNodeContextmenu"
      @node-click="onNodeClick"
    >
      <!-- 自定义节点：前缀图标 + 名称 -->
      <template #default="{ data }">
        <span class="tree-node">
          <el-icon class="tree-node-icon" :class="{ 'is-top': !data.parentId }">
            <component :is="nodeIcon(data.type)" />
          </el-icon>
          <span class="tree-node-label">{{ data.name }}</span>
        </span>
      </template>
    </el-tree>

    <!-- 右键菜单 -->
    <div
      v-if="contextMenu.visible"
      class="context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
    >
      <div class="menu-item" @click="openCreateDialog">新建子分类</div>
      <div class="menu-item" @click="openRenameDialog">重命名</div>
      <div class="menu-item danger" @click="confirmDelete">删除</div>
    </div>

    <!-- 新建子分类对话框 -->
    <el-dialog v-model="createDialog.visible" title="新建子分类" width="420px">
      <el-form label-width="80px">
        <el-form-item label="名称">
          <el-input
            v-model="createDialog.name"
            placeholder="请输入分类名称"
            maxlength="100"
            show-word-limit
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 新建顶层分类对话框 -->
    <el-dialog v-model="createTopDialog.visible" title="新建顶层分类" width="480px">
      <el-form label-width="90px">
        <el-form-item label="名称">
          <el-input
            v-model="createTopDialog.name"
            placeholder="请输入分类名称（如：会议纪要）"
            maxlength="100"
            show-word-limit
          />
        </el-form-item>
        <el-form-item label="类型标识">
          <el-input
            v-model="createTopDialog.type"
            placeholder="英文标识，如 meeting_minutes"
            maxlength="50"
          />
          <div class="type-hint">
            可从已知类型选择或自定义：
            <el-select
              v-model="createTopDialog.type"
              placeholder="选择或自定义"
              filterable
              allow-create
              default-first-option
              size="small"
              class="type-select"
            >
              <el-option v-for="t in knownTypes" :key="t" :label="t" :value="t" />
            </el-select>
          </div>
        </el-form-item>
        <el-form-item label="排序值">
          <el-input-number v-model="createTopDialog.sort" :min="0" :controls="false" />
          <span class="sort-hint">数字越小越靠前</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createTopDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitCreateTop">创建</el-button>
      </template>
    </el-dialog>

    <!-- 重命名对话框 -->
    <el-dialog v-model="renameDialog.visible" title="重命名分类" width="420px">
      <el-form label-width="80px">
        <el-form-item label="名称">
          <el-input
            v-model="renameDialog.name"
            placeholder="请输入新的分类名称"
            maxlength="100"
            show-word-limit
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="renameDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitRename">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.category-tree {
  position: relative;
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
}
.tree-toolbar {
  padding: var(--lx-space-2) var(--lx-space-3);
  border-bottom: 1px solid var(--lx-border-light);
}

/* el-tree 节点行高/字号优化：默认 26px 偏挤，调大让字体更舒展 */
.category-tree :deep(.el-tree-node__content) {
  height: 36px;
  line-height: 36px;
}
.category-tree :deep(.el-tree-node__label) {
  font-size: var(--lx-font-base);
}
/* 顶层分类（一级节点）字号加大 + 加粗，层级更分明 */
.category-tree :deep(.el-tree > .el-tree-node > .el-tree-node__content > .el-tree-node__label) {
  font-size: var(--lx-font-md);
  font-weight: var(--lx-font-semibold);
}
/* 顶层节点图标也相应放大 */
.category-tree :deep(.el-tree > .el-tree-node > .el-tree-node__content .tree-node-icon) {
  font-size: 16px;
}

/* 自定义树节点：前缀图标 + 名称 */
.tree-node {
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  flex: 1;
  min-width: 0;
}
.tree-node-icon {
  color: var(--lx-text-placeholder);
  flex-shrink: 0;
}
/* 顶层分类图标用主色，子分类保持灰色 */
.tree-node-icon.is-top {
  color: var(--lx-primary);
}
.tree-node-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.type-hint {
  margin-top: var(--lx-space-2);
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
  display: flex;
  align-items: center;
  gap: var(--lx-space-2);
  flex-wrap: wrap;
}
.type-select {
  width: 200px;
}
.sort-hint {
  margin-left: var(--lx-space-2);
  font-size: var(--lx-font-xs);
  color: var(--lx-text-placeholder);
}

.context-menu {
  position: fixed;
  z-index: 3000;
  min-width: 140px;
  padding: var(--lx-space-1) 0;
  background: var(--lx-bg-elevated);
  border: 1px solid var(--lx-border);
  border-radius: var(--lx-radius-md);
  box-shadow: var(--lx-shadow-lg);
}

.menu-item {
  padding: var(--lx-space-2) var(--lx-space-4);
  font-size: var(--lx-font-base);
  color: var(--lx-text-regular);
  cursor: pointer;
}

.menu-item:hover {
  background: var(--lx-primary-50);
}

.menu-item.danger {
  color: var(--lx-danger);
}

.menu-item.danger:hover {
  background: var(--lx-danger-bg);
}
</style>

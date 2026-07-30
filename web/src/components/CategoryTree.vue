<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  createCategory,
  deleteCategory,
  getCategoriesTree,
  updateCategory,
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
    <el-tree
      :data="treeData"
      :props="treeProps"
      node-key="id"
      highlight-current
      default-expand-all
      @node-contextmenu="onNodeContextmenu"
      @node-click="onNodeClick"
    />

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
}

.context-menu {
  position: fixed;
  z-index: 3000;
  min-width: 140px;
  padding: 4px 0;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
}

.menu-item {
  padding: 8px 16px;
  font-size: 14px;
  color: #303133;
  cursor: pointer;
}

.menu-item:hover {
  background: #f5f7fa;
}

.menu-item.danger {
  color: #f56c6c;
}

.menu-item.danger:hover {
  background: #fef0f0;
}
</style>

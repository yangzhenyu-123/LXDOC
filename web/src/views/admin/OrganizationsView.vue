<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  ElMessage,
  ElMessageBox,
  type FormInstance,
  type FormRules,
} from 'element-plus';
import {
  listOrganizations,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
  type Organization,
  type OrganizationType,
  type OrgMember,
  type OrgMemberRole,
} from '@/api/organizations';
import { listUsersApi, type UserItem } from '@/api/users';

// 组织管理页：管理员可维护 部门 > 组 树，并为节点分配成员编辑授权。
// 读权限（每层有读）由后端在读接口过滤；编辑权限（需对应编辑授权）通过成员授权表控制。

// 扁平组织列表
const orgList = ref<Organization[]>([]);
const loading = ref(false);

// 当前选中的节点
const selectedOrg = ref<Organization | null>(null);

// 树字段映射
const treeProps = { label: 'name', children: 'children' };

// 扁平 → 树
interface OrgNode extends Organization {
  children?: OrgNode[];
}

const orgTree = computed<OrgNode[]>(() => {
  const map = new Map<string, OrgNode>();
  const roots: OrgNode[] = [];
  // 先建索引
  for (const o of orgList.value) {
    map.set(o.id, { ...o, children: [] });
  }
  // 再挂载父子
  for (const o of orgList.value) {
    const node = map.get(o.id)!;
    if (o.parentId && map.has(o.parentId)) {
      map.get(o.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }
  // 按 sort 排序
  const sortRec = (nodes: OrgNode[]) => {
    nodes.sort((a, b) => a.sort - b.sort);
    nodes.forEach((n) => {
      if (n.children?.length) sortRec(n.children);
    });
  };
  sortRec(roots);
  return roots;
});

// 类型 → 标签与颜色
function typeLabel(t: OrganizationType): string {
  return t === 'department' ? '部门' : '组';
}
function typeTagType(
  t: OrganizationType,
): '' | 'success' {
  return t === 'department' ? '' : 'success';
}

// 路径展示：把 path 段映射为节点名（研发部 / 前端组）
function pathLabel(org: Organization): string {
  if (!org.path) return org.name;
  const ids = org.path.split('.').filter(Boolean);
  const map = new Map(orgList.value.map((o) => [o.id, o.name]));
  return ids.map((id) => map.get(id) ?? id).join(' / ');
}

// ============== 节点 CRUD ==============

// 新建节点对话框（部门 / 组共用）
const nodeDialog = reactive({
  visible: false,
  mode: 'create' as 'create' | 'rename',
  type: 'department' as OrganizationType,
  parentId: null as string | null,
  id: '',
  name: '',
  sort: 0,
});
const nodeFormRef = ref<FormInstance>();
const nodeRules: FormRules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
};
const nodeSaving = ref(false);

// 打开新建部门（顶层）
function openCreateDepartment() {
  nodeDialog.mode = 'create';
  nodeDialog.type = 'department';
  nodeDialog.parentId = null;
  nodeDialog.id = '';
  nodeDialog.name = '';
  nodeDialog.sort = 0;
  nodeDialog.visible = true;
}

// 打开新建子组（在选中的部门下）
function openCreateGroup(parent: Organization) {
  if (parent.type !== 'department') {
    ElMessage.warning('组只能挂在部门下');
    return;
  }
  nodeDialog.mode = 'create';
  nodeDialog.type = 'group';
  nodeDialog.parentId = parent.id;
  nodeDialog.id = '';
  nodeDialog.name = '';
  nodeDialog.sort = 0;
  nodeDialog.visible = true;
}

// 打开重命名
function openRename(org: Organization) {
  nodeDialog.mode = 'rename';
  nodeDialog.type = org.type;
  nodeDialog.parentId = org.parentId;
  nodeDialog.id = org.id;
  nodeDialog.name = org.name;
  nodeDialog.sort = org.sort;
  nodeDialog.visible = true;
}

async function submitNode() {
  if (!nodeFormRef.value) return;
  await nodeFormRef.value.validate(async (valid) => {
    if (!valid) return;
    nodeSaving.value = true;
    try {
      if (nodeDialog.mode === 'create') {
        await createOrganization({
          type: nodeDialog.type,
          name: nodeDialog.name.trim(),
          parentId: nodeDialog.parentId,
          sort: nodeDialog.sort,
        });
        ElMessage.success('创建成功');
      } else {
        await updateOrganization(nodeDialog.id, {
          name: nodeDialog.name.trim(),
          sort: nodeDialog.sort,
        });
        ElMessage.success('已更新');
      }
      nodeDialog.visible = false;
      await loadOrganizations();
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || '操作失败';
      ElMessage.error(typeof msg === 'string' ? msg : '操作失败');
    } finally {
      nodeSaving.value = false;
    }
  });
}

// 删除节点
async function onDelete(org: Organization) {
  try {
    await ElMessageBox.confirm(
      `确认删除「${org.name}」？存在子节点或关联文档时无法删除。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await deleteOrganization(org.id);
    ElMessage.success('已删除');
    if (selectedOrg.value?.id === org.id) {
      selectedOrg.value = null;
    }
    await loadOrganizations();
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '删除失败';
    ElMessage.error(typeof msg === 'string' ? msg : '删除失败');
  }
}

// 选中节点
function onNodeClick(data: OrgNode) {
  selectedOrg.value = data;
  if (data) {
    loadMembers(data.id);
  }
}

// ============== 成员管理 ==============

const members = ref<OrgMember[]>([]);
const memberLoading = ref(false);

async function loadMembers(orgId: string) {
  memberLoading.value = true;
  try {
    members.value = (await listMembers(orgId)) ?? [];
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '加载成员失败';
    ElMessage.error(typeof msg === 'string' ? msg : '加载成员失败');
    members.value = [];
  } finally {
    memberLoading.value = false;
  }
}

// 添加成员对话框
const memberDialog = reactive({
  visible: false,
  userId: '' as string,
  role: 'editor' as OrgMemberRole,
  saving: false,
});
// 全量用户（用于添加成员时选择）
const allUsers = ref<UserItem[]>([]);

async function openAddMember() {
  if (!selectedOrg.value) return;
  memberDialog.userId = '';
  memberDialog.role = 'editor';
  memberDialog.visible = true;
  // 懒加载用户列表
  if (allUsers.value.length === 0) {
    try {
      const res = await listUsersApi(1, 200);
      allUsers.value = res.items ?? [];
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || '加载用户失败';
      ElMessage.error(typeof msg === 'string' ? msg : '加载用户失败');
    }
  }
}

// 已是成员的用户 id 集合（添加时排除）
const memberUserIds = computed(() =>
  new Set(members.value.map((m) => m.userId)),
);

// 可选用户（排除已是成员）
const candidateUsers = computed(() =>
  allUsers.value.filter((u) => !memberUserIds.value.has(u.id)),
);

async function submitAddMember() {
  if (!selectedOrg.value) return;
  if (!memberDialog.userId) {
    ElMessage.warning('请选择用户');
    return;
  }
  memberDialog.saving = true;
  try {
    await addMember(selectedOrg.value.id, memberDialog.userId, memberDialog.role);
    ElMessage.success('已添加成员');
    memberDialog.visible = false;
    await loadMembers(selectedOrg.value.id);
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '添加失败';
    ElMessage.error(typeof msg === 'string' ? msg : '添加失败');
  } finally {
    memberDialog.saving = false;
  }
}

// 改成员角色
async function onRoleChange(member: OrgMember, newRole: OrgMemberRole) {
  if (!selectedOrg.value) return;
  try {
    await updateMemberRole(selectedOrg.value.id, member.userId, newRole);
    ElMessage.success('角色已更新');
    await loadMembers(selectedOrg.value.id);
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '更新失败';
    ElMessage.error(typeof msg === 'string' ? msg : '更新失败');
    await loadMembers(selectedOrg.value.id);
  }
}

// 移除成员
async function onRemoveMember(member: OrgMember) {
  if (!selectedOrg.value) return;
  try {
    await ElMessageBox.confirm(
      `确认移除成员「${member.username}」？移除后该用户将失去此节点的编辑授权。`,
      '移除确认',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await removeMember(selectedOrg.value.id, member.userId);
    ElMessage.success('已移除成员');
    await loadMembers(selectedOrg.value.id);
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '移除失败';
    ElMessage.error(typeof msg === 'string' ? msg : '移除失败');
  }
}

// 角色标签
function roleTagType(role: OrgMemberRole): 'danger' | 'primary' {
  return role === 'admin' ? 'danger' : 'primary';
}

// 时间格式化
function formatTime(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/**
 * 加载组织树
 */
async function loadOrganizations() {
  loading.value = true;
  try {
    orgList.value = (await listOrganizations()) ?? [];
    // 若有选中节点，刷新其最新数据
    if (selectedOrg.value) {
      const fresh = orgList.value.find(
        (o) => o.id === selectedOrg.value!.id,
      );
      selectedOrg.value = fresh ?? null;
    }
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '加载组织失败';
    ElMessage.error(typeof msg === 'string' ? msg : '加载组织失败');
    orgList.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(loadOrganizations);
</script>

<template>
  <div class="org-view">
    <div class="page-toolbar">
      <h2 class="page-title">组织管理</h2>
      <div class="toolbar-actions">
        <el-button type="primary" @click="openCreateDepartment">
          <el-icon class="el-icon--left"><Plus /></el-icon>
          新建部门
        </el-button>
        <el-button
          :disabled="!selectedOrg || selectedOrg.type !== 'department'"
          @click="openCreateGroup(selectedOrg!)"
        >
          新建子组
        </el-button>
      </div>
    </div>

    <div class="org-body">
      <!-- 左侧组织树 -->
      <div class="org-tree-panel">
        <div class="panel-title">组织树</div>
        <el-tree
          :data="orgTree"
          :props="treeProps"
          node-key="id"
          highlight-current
          default-expand-all
          v-loading="loading"
          @node-click="onNodeClick"
        >
          <template #default="{ data }">
            <span class="tree-node">
              <el-icon class="node-icon">
                <OfficeBuilding v-if="data.type === 'department'" />
                <User v-else />
              </el-icon>
              <span class="node-name">{{ data.name }}</span>
              <el-tag
                :type="typeTagType(data.type)"
                size="small"
                effect="plain"
                class="node-type-tag"
              >
                {{ typeLabel(data.type) }}
              </el-tag>
            </span>
          </template>
        </el-tree>
        <el-empty
          v-if="!loading && orgList.length === 0"
          description="暂无组织，请新建部门"
          :image-size="80"
        />
      </div>

      <!-- 右侧详情与成员管理 -->
      <div class="org-detail-panel">
        <template v-if="selectedOrg">
          <!-- 节点详情 -->
          <el-card shadow="never" class="detail-card">
            <template #header>
              <div class="detail-header">
                <span class="detail-title">
                  {{ selectedOrg.name }}
                  <el-tag
                    :type="typeTagType(selectedOrg.type)"
                    size="small"
                    effect="plain"
                  >
                    {{ typeLabel(selectedOrg.type) }}
                  </el-tag>
                </span>
                <div class="detail-actions">
                  <el-button
                    v-if="selectedOrg.type === 'department'"
                    size="small"
                    type="primary"
                    plain
                    @click="openCreateGroup(selectedOrg)"
                  >
                    新建子组
                  </el-button>
                  <el-button size="small" @click="openRename(selectedOrg)">
                    重命名
                  </el-button>
                  <el-button
                    size="small"
                    type="danger"
                    plain
                    @click="onDelete(selectedOrg)"
                  >
                    删除
                  </el-button>
                </div>
              </div>
            </template>
            <ul class="meta-list">
              <li>
                <span class="meta-key">层级路径</span>
                <span class="meta-val">{{ pathLabel(selectedOrg) }}</span>
              </li>
              <li>
                <span class="meta-key">排序</span>
                <span class="meta-val">{{ selectedOrg.sort }}</span>
              </li>
              <li>
                <span class="meta-key">创建时间</span>
                <span class="meta-val">{{ formatTime(selectedOrg.createdAt) }}</span>
              </li>
            </ul>
          </el-card>

          <!-- 成员管理 -->
          <el-card shadow="never" class="detail-card">
            <template #header>
              <div class="detail-header">
                <span class="detail-title">成员授权</span>
                <el-button
                  size="small"
                  type="primary"
                  @click="openAddMember"
                >
                  <el-icon class="el-icon--left"><Plus /></el-icon>
                  添加成员
                </el-button>
              </div>
            </template>
            <el-table
              :data="members"
              v-loading="memberLoading"
              border
              stripe
              size="small"
              empty-text="该节点暂无授权成员，editor/admin 可编辑此节点及子树下文档"
            >
              <el-table-column label="用户名" prop="username" min-width="120" />
              <el-table-column label="邮箱" prop="email" min-width="200" show-overflow-tooltip />
              <el-table-column label="角色" width="240">
                <template #default="{ row }">
                  <el-select
                    :model-value="row.role"
                    size="small"
                    style="width: 220px"
                    @change="(v: OrgMemberRole) => onRoleChange(row, v)"
                  >
                    <el-option label="编辑（可编辑文档）" value="editor" />
                    <el-option label="管理员（可管理成员/子节点）" value="admin" />
                  </el-select>
                  <el-tag
                    :type="roleTagType(row.role)"
                    size="small"
                    style="margin-left: 6px"
                  >
                    {{ row.role }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="授权时间" width="160">
                <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="90" fixed="right">
                <template #default="{ row }">
                  <el-button
                    type="danger"
                    size="small"
                    text
                    @click="onRemoveMember(row)"
                  >
                    移除
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
        </template>

        <el-empty
          v-else
          description="请选择左侧节点查看详情与管理成员"
          :image-size="120"
        />
      </div>
    </div>

    <!-- 新建/重命名节点对话框 -->
    <el-dialog
      v-model="nodeDialog.visible"
      :title="nodeDialog.mode === 'create' ? (nodeDialog.type === 'department' ? '新建部门' : '新建组') : '重命名节点'"
      width="440px"
      :close-on-click-modal="false"
    >
      <el-form
        ref="nodeFormRef"
        :model="nodeDialog"
        :rules="nodeRules"
        label-position="top"
      >
        <el-form-item label="名称" prop="name">
          <el-input
            v-model="nodeDialog.name"
            placeholder="请输入名称"
            maxlength="100"
            show-word-limit
            clearable
          />
        </el-form-item>
        <el-form-item label="排序（数字越小越靠前）">
          <el-input-number v-model="nodeDialog.sort" :min="0" :max="9999" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="nodeDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="nodeSaving" @click="submitNode">
          确认
        </el-button>
      </template>
    </el-dialog>

    <!-- 添加成员对话框 -->
    <el-dialog
      v-model="memberDialog.visible"
      title="添加成员"
      width="440px"
      :close-on-click-modal="false"
    >
      <el-form label-position="top">
        <el-form-item label="用户">
          <el-select
            v-model="memberDialog.userId"
            filterable
            placeholder="选择用户"
            style="width: 100%"
          >
            <el-option
              v-for="u in candidateUsers"
              :key="u.id"
              :label="`${u.username}（${u.email}）`"
              :value="u.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="memberDialog.role">
            <el-radio value="editor">编辑（可编辑文档）</el-radio>
            <el-radio value="admin">管理员（可管理成员/子节点）</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <div v-if="candidateUsers.length === 0" class="empty-tip">
        没有可选用户（所有用户均已授权或系统无其他用户）
      </div>
      <template #footer>
        <el-button @click="memberDialog.visible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="memberDialog.saving"
          @click="submitAddMember"
        >
          添加
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.org-view {
  display: flex;
  flex-direction: column;
  padding: 16px;
  height: 100%;
  overflow: hidden;
}
.page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  flex-shrink: 0;
}
.page-title {
  margin: 0;
  font-size: 18px;
  color: #1f2a44;
}
.toolbar-actions {
  display: flex;
  gap: 8px;
}
.org-body {
  flex: 1;
  display: flex;
  gap: 12px;
  overflow: hidden;
}
.org-tree-panel {
  width: 300px;
  flex-shrink: 0;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  padding: 12px;
  overflow: auto;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.tree-node {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
}
.node-icon {
  color: #909399;
  font-size: 14px;
}
.node-name {
  flex: 1;
}
.node-type-tag {
  margin-left: 4px;
}
.org-detail-panel {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.detail-card {
  border: 1px solid #e4e7ed;
  border-radius: 4px;
}
.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.detail-title {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.detail-actions {
  display: flex;
  gap: 6px;
}
.meta-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.meta-list li {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 13px;
  border-bottom: 1px dashed #ebeef5;
}
.meta-list li:last-child {
  border-bottom: none;
}
.meta-key {
  color: #909399;
}
.meta-val {
  color: #303133;
  text-align: right;
  max-width: 60%;
  word-break: break-all;
}
.empty-tip {
  margin-top: 8px;
  font-size: 12px;
  color: #909399;
}
</style>

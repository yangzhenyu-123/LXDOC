# 权限模型

本文详细描述 LXDOC 的「部门 / 组 / 个人」三层组织权限体系，以及 RBAC + ACL 混合模型的读写判断规则。

## 权限模型总览

LXDOC 采用 **RBAC（角色）+ 组织级 ACL（资源归属）** 混合模型：

- **RBAC**：全局角色 `admin / editor / viewer`，控制功能入口（如用户管理、审计查询仅 admin）
- **ACL**：基于资源归属（个人 / 组 / 部门）的读 / 写权限，控制具体文档 / 分类的可见与可编辑范围
- **组织树**：通用树（部门 > 组），通过物化路径 `path` 实现权限继承，免递归查询

## 组织树（通用树）

### 节点类型

| 类型 | 说明 | 约束 |
|---|---|---|
| `department` 部门 | 顶层节点 | `parent_id` 必须为 null |
| `group` 组 | 部门下子节点 | `parent_id` 必须指向某 department |

### 物化路径 `path`

- 段之间以 `.` 分隔，每段使用节点 **id（UUID）**，保证唯一、无需 slug 去重
- 顶层部门：`path = <自身 id>`
- 子组：`path = <父节点 path>.<自身 id>`
- 例：部门「研发部」`path = uuid-a`，其下组「前端组」`path = uuid-a.uuid-b`

> 选用 UUID 而非 slug 作为路径段，避免重名冲突；用户祖先 org id 集合直接由 `user.orgPath.split('.')` 得到，无需查库。

### 个人空间

个人空间不建组织节点，由文档的 `owner_type='personal'` + `owner_id=<user.id>` 表达。每个用户自动拥有一个个人空间（即所有 `owner_id=自己` 的文档）。

## 用户与组织的关联

### `users.organization_id`

用户所属组织节点（通常指向某个 `group`）。全局 admin 为 null（不属任何部门，全权）。

该字段在登录时由 `JwtStrategy.validate` 解析为 `orgPath`（用户所属节点的完整物化路径）写入 JWT，供读权限判断免查库。

### `user_org_roles`（编辑授权）

| 字段 | 说明 |
|---|---|
| `user_id` | 用户 |
| `org_id` | 组织节点 |
| `role` | `editor` 或 `admin`（在该节点的角色） |
| UNIQUE | `(user_id, org_id)` |

- `editor`：可编辑该节点及其子孙下的文档
- `admin`：可编辑 + 可管理该节点成员与子节点（向下继承）

> 编辑授权在请求时由 `AccessControlService` 从 `user_org_roles` 实时查询（带 30s 缓存），不进 JWT，避免权限变更不及时与 JWT 过大。

## 文档归属

`documents` 表通过两个字段表达归属：

| `owner_type` | `owner_id` | 含义 |
|---|---|---|
| `personal` | 创建者 user id | 个人私有空间 |
| `group` | organization id | 归属某组 |
| `department` | organization id | 归属某部门 |

`created_by` 始终记录实际创建人（不变），用于审计追溯。

## 读取权限规则

用户可见文档集合 = 个人文档 ∪ 所属组织子树文档 ∪ admin 全读。

判断逻辑（`AccessControlService.canRead`）：

```
if user.role === ADMIN:           return true              // admin 全读
if doc.ownerType === PERSONAL:    return doc.ownerId === user.id   // 仅本人
// group / department：owner 节点是用户祖先或自身
const ancestorIds = user.orgPath?.split('.') ?? []
return ancestorIds.includes(doc.ownerId)
```

**语义**：用户可读其所属节点「自身及其所有子孙」下的文档。

例：
- 用户属 `dept-a.group-b`（`path = a.b`），祖先+自身 id 集 = `{a, b}`
- 可读 owner 为 `dept-a`（`a`）和 `dept-a.group-b`（`b`）的文档
- 不可读 `dept-c` 的文档

### 列表/搜索的读过滤

`AccessControlService.applyReadScopeToQb` 把上述规则注入 QueryBuilder WHERE：

```sql
-- 非 admin：
(d.owner_type='personal' AND d.owner_id=:userId)
OR
(d.owner_type IN ('group','department') AND d.owner_id IN (:...ancestorIds))
```

`findRecent` / `listByCategory` / `search` 均复用此过滤，避免每个读接口手写。

## 编辑权限规则

用户可编辑文档当且仅当满足其一（`AccessControlService.canWrite`）：

1. 全局 `admin`
2. `personal` 文档且 `owner_id === 当前用户`
3. `group`/`department` 文档，且用户在 owner 节点有 `editor` 或 `admin` 角色（精确命中）
4. 用户对该文档 owner 的**任一祖先**节点有 `admin` 角色（向下继承）

判断流程：

```
if user.role === ADMIN: return true
if doc.ownerType === PERSONAL: return doc.ownerId === user.id
if !doc.ownerId: return false

roles = getManageableRoles(user.id)    // 从 user_org_roles 查，30s 缓存
if roles.some(r => r.orgId === doc.ownerId): return true   // 精确命中

ownerOrg = organizations.findById(doc.ownerId)
return roles.some(r =>
  r.role === ADMIN &&
  (ownerOrg.path === r.path || ownerOrg.path.startsWith(r.path + '.'))
)
```

**语义**：在祖先部门当 admin，则对子孙所有节点有编辑权；在某个节点当 editor，只能编辑该节点下的文档，不能跨节点。

### 写操作校验位置

所有写接口在 service 层调用 `accessControl.assertCanWrite(user, doc)`，失败抛 403：

- `DocumentsService.update` / `rollback` / `remove` / `convertToEditable`
- `OnlyOfficeService.buildConfig`（mode=edit 时）
- 分类 CRUD 的对应方法

## 组织管理权限

组织节点本身的 CRUD / 成员管理，由 `AccessControlService.canManageOrg` 判断：

- 全局 admin 全权
- 否则需在该节点或其祖先有 `admin` 角色

## JWT 载荷

`AuthUser`（JwtStrategy.validate 写入 `req.user`）：

```ts
interface AuthUser {
  id: string;
  role: 'admin' | 'editor' | 'viewer';
  organizationId: string | null;  // 用户所属组织节点 id
  orgPath: string | null;         // 所属节点物化路径（祖先+自身 id 集）
}
```

- 读权限：完全依赖 JWT 中的 `orgPath`，免查库
- 编辑授权：JWT 不携带，请求时实时查 `user_org_roles`（30s 缓存），保证权限变更及时生效

## 静态文件鉴权

原文件 / 图片不裸暴露，统一走签名 URL：

1. 前端先调 `GET /api/files/token/:docId`（带 Bearer，后端校验读权限）拿短期 token
2. 拼接到文件 URL：`/api/files/:docId/original?token=` 或 `/api/files/:docId/image/:name?token=`
3. 该接口 `@Public` 跳过 JwtAuthGuard，由 `FilesService.verifyFileToken` 校验 token 签名、过期、docId 匹配

token 有效期默认 10 分钟（`FILE_TOKEN_EXPIRES`），绑定 docId，不可跨文档使用。OnlyOffice 拉取 docx 也用此机制。

## 权限矩阵示例

设组织树：`dept-a`（path=`a`）下有 `group-b`（path=`a.b`）。

| 用户 | 角色 | organization_id | user_org_roles | 可读 | 可编辑 |
|---|---|---|---|---|---|
| U1 | admin | null | - | 全部 | 全部 |
| U2 | editor | group-b (a.b) | - | personal 自身 + dept-a / group-b 下文档 | 仅 personal 自身 |
| U3 | editor | group-b (a.b) | group-b: editor | 同上 | personal 自身 + group-b 下文档 |
| U4 | editor | group-b (a.b) | dept-a: admin | 同上 | personal 自身 + dept-a 全部子孙（含 group-b）下文档 |

## 迁移与兼容

- 存量 `Document`：`owner_type='personal'`、`owner_id=created_by`（在 `AppModule.onApplicationBootstrap` 回填）
- 存量 `User`：`organization_id=null`（管理员后续分配）
- 存量 `Category`：`organization_id=null`（公共树）
- 存量 `Document.content_source`：md/txt→`manual`，docx/odt→`pandoc`，pdf→`pdf_text`

# 用户管理与权限管理 Spec

## Why
原 init-enterprise-kb spec 把多用户/权限列为"非目标"，仅预留 `user_id` 字段。现业务需要让多人协作使用同一知识库，必须区分谁能读、谁能写、谁能管理用户，并记录关键操作以便追溯。本变更在不破坏已有 MVP 功能的前提下，为 LXDOC 增加完整的认证、RBAC、ACL 与审计能力。

## What Changes
- 新增 `User` 实体（email/username/passwordHash/role/status）与 `AuditLog` 实体
- 新增 `AuthModule`：注册（受 `ALLOW_SIGNUP` 开关控制）/ 登录 / 登出 / 刷新 token / 修改密码
- 新增 JWT 双 token 机制（access 15min + refresh 7d），access 通过 `Authorization: Bearer` 携带
- 新增 `RolesGuard` + `@Roles()` 装饰器实现 RBAC：admin / editor / viewer 三角色
- 新增 `ACL`：分类级与文档级权限（read/write/delete/upload），admin 拥有全部，editor 默认可读写上传，viewer 默认只读
- 新增 `AuditMiddleware`/拦截器：记录登录、登出、文档 CRUD、分类 CRUD、权限变更等关键操作到 `AuditLog`
- **BREAKING**：所有 `/api/documents`、`/api/categories`、`/api/uploads`、`/api/search` 接口改为需登录（除登录注册外）；上传与文档写入需 editor+，删除需 admin
- 前端新增 `/login` 登录页、用户菜单（顶部栏右侧）、`/admin/users` 用户管理页（仅 admin）、`/admin/audit` 审计日志页（仅 admin）
- 前端 axios 拦截器自动注入 JWT，401 时自动尝试 refresh，失败跳登录
- 文档/分类实体新增 `createdBy` 字段记录创建者，用于"我的文档"视图与权限判断

## Impact
- Affected specs: `init-enterprise-kb`（其"非目标"中的多用户/权限/审计条目被本 spec 取代）
- Affected code:
  - 后端新增 `auth/`、`users/`、`audit/`、`common/guards/`、`common/decorators/` 模块
  - 后端 `documents/`、`categories/`、`uploads/`、`search/` controller 增加 `@UseGuards(JwtAuthGuard, RolesGuard)` 与 `@Roles()` 装饰器
  - 后端 `documents.service.ts` / `categories.service.ts` 增加权限校验逻辑（viewer 不能写、editor 不能删他人文档、admin 全权）
  - 前端 `App.vue` 顶部栏右侧加用户菜单；新增路由 `/login`、`/admin/users`、`/admin/audit`
  - 前端 `api/client.ts` 增加请求/响应拦截器处理 JWT
  - 前端新增 `views/LoginView.vue`、`views/admin/UsersView.vue`、`views/admin/AuditView.vue`
  - 数据库迁移：新建 `users`、`audit_logs` 表；`documents`、`categories` 加 `created_by` 列
- 外部依赖新增：`@nestjs/jwt`、`@nestjs/passport`、`passport`、`passport-jwt`、`bcryptjs`、`@types/bcryptjs`

## ADDED Requirements

### Requirement: 用户实体与初始化
系统 SHALL 提供 `User` 实体，字段含 id(uuid)、email(unique)、username(unique)、passwordHash、role(enum: admin/editor/viewer)、status(enum: active/disabled)、createdAt、updatedAt。系统启动时若 `users` 表为空，SHALL 自动 seed 一个默认管理员账户（email=`admin@lxdoc.local`，密码=`lxdoc12345`，role=admin），并在日志中打印初始密码提示修改。

#### Scenario: 首次启动 seed 管理员
- **WHEN** 系统首次启动且 `users` 表为空
- **THEN** 自动创建 admin@lxdoc.local / lxdoc12345 管理员账户
- **AND** 日志输出警告提示修改默认密码

### Requirement: 认证（JWT 双 token）
系统 SHALL 提供 `POST /api/auth/login`（body: email+password）返回 `{ accessToken, refreshToken, user }`，access token 有效期 15 分钟，refresh token 7 天。系统 SHALL 提供 `POST /api/auth/refresh`（body: refreshToken）返回新 access token。系统 SHALL 提供 `POST /api/auth/logout` 使当前 refresh token 失效。

#### Scenario: 登录成功
- **WHEN** 用户用正确 email+password 调用 `/api/auth/login`
- **THEN** 返回 200 与双 token + 用户信息（不含 passwordHash）

#### Scenario: 登录失败
- **WHEN** 凭据错误或账户被禁用
- **THEN** 返回 401，错误信息不区分"用户不存在"与"密码错误"

#### Scenario: 刷新 token
- **WHEN** access token 过期，前端用 refresh token 调用 `/api/auth/refresh`
- **THEN** 返回新 access token，refresh token 不变

### Requirement: 注册（受开关控制）
系统 SHALL 通过 `ALLOW_SIGNUP` 环境变量控制是否允许 `POST /api/auth/register` 自注册，默认 `false`。开启时新注册用户默认 role=viewer、status=active。关闭时该接口返回 403。

#### Scenario: 关闭自注册
- **WHEN** `ALLOW_SIGNUP=false` 时调用 `/api/auth/register`
- **THEN** 返回 403 禁止注册

#### Scenario: 开启自注册
- **WHEN** `ALLOW_SIGNUP=true` 且 email 未被占用
- **THEN** 创建 viewer 角色用户并返回登录态

### Requirement: RBAC 角色守卫
系统 SHALL 提供 `@Roles('admin'|'editor'|'viewer')` 装饰器与 `RolesGuard`，对标注的接口校验当前用户角色是否匹配，不匹配返回 403。

#### Scenario: viewer 尝试写入
- **WHEN** viewer 角色用户调用 `POST /api/uploads`
- **THEN** 返回 403

#### Scenario: editor 调用管理接口
- **WHEN** editor 角色用户调用 `DELETE /api/users/:id`
- **THEN** 返回 403（仅 admin 可操作）

### Requirement: 资源级 ACL
系统 SHALL 在文档/分类的写操作上校验：editor 仅能修改自己创建的文档/分类，admin 可修改任意；viewer 仅读。删除操作仅 admin 与创建者本人（editor）可执行。

#### Scenario: editor 修改他人文档
- **WHEN** editor A 调用 `PUT /api/documents/<B创建的文档>`
- **THEN** 返回 403

#### Scenario: 创建者删除自己的文档
- **WHEN** editor A 调用 `DELETE /api/documents/<A创建的文档>`
- **THEN** 允许删除

### Requirement: 用户管理（仅 admin）
系统 SHALL 提供 `GET /api/users`（列表，分页）、`PATCH /api/users/:id`（改 role/status）、`POST /api/users`（管理员直接创建用户，不受 ALLOW_SIGNUP 限制）、`DELETE /api/users/:id`（不能删自己、不能删最后一个 admin）。所有接口仅 admin 可访问。

#### Scenario: 删除最后一个 admin
- **WHEN** admin 调用 `DELETE /api/users/<最后一个 admin>`
- **THEN** 返回 400 拒绝

#### Scenario: admin 创建 editor
- **WHEN** admin 调用 `POST /api/users` body 含 role=editor
- **THEN** 创建成功并返回用户信息

### Requirement: 修改密码
系统 SHALL 提供 `PATCH /api/auth/change-password`（body: oldPassword+newPassword），校验旧密码后更新 passwordHash，使该用户所有 refresh token 失效。

### Requirement: 审计日志
系统 SHALL 提供 `AuditLog` 实体记录：userId、action(enum: login/logout/document_create/document_update/document_delete/category_create/category_delete/user_create/user_update/user_delete/permission_change)、targetType、targetId、detail(jsonb)、ip、userAgent、createdAt。系统 SHALL 提供 `GET /api/audit`（仅 admin，分页，可按 userId/action/时间范围筛选）。

#### Scenario: 记录文档创建
- **WHEN** editor 创建文档成功后
- **THEN** audit_logs 表新增一条 action=document_create 的记录

### Requirement: 前端登录与权限路由
系统 SHALL 提供 `/login` 登录页，未登录访问受保护路由时跳转登录。系统 SHALL 在顶部栏右侧显示当前用户名 + 下拉菜单（修改密码、退出登录；admin 额外显示"用户管理""审计日志"入口）。系统 SHALL 在 axios 拦截器自动注入 JWT，401 时自动 refresh，refresh 失败跳登录。

#### Scenario: 未登录访问受保护页
- **WHEN** 未登录用户访问 `/d/:docId`
- **THEN** 跳转 `/login?redirect=/d/:docId`，登录后跳回原页面

#### Scenario: token 自动刷新
- **WHEN** 接口返回 401 且本地有 refresh token
- **THEN** 自动调用 `/api/auth/refresh`，成功后重放原请求

## MODIFIED Requirements

### Requirement: 接口鉴权（取代 init-enterprise-kb 中"无鉴权"的隐含设定）
init-enterprise-kb 的 `/api/documents`、`/api/categories`、`/api/uploads`、`/api/search` 现统一要求 `JwtAuthGuard`。读操作（GET）需 viewer+，写操作（POST/PUT/PATCH/DELETE）需 editor+，删除与用户管理需 admin。`/api/auth/login`、`/api/auth/register`、`/health` 不需要鉴权。

## REMOVED Requirements

### Requirement: 多用户作为非目标
**Reason**: 本 spec 将多用户/权限/审计从非目标升级为正式需求
**Migration**: 原 `Document.user_id` 字段保留并改名为 `created_by`（数据迁移脚本在首次启动时执行：`ALTER TABLE documents RENAME COLUMN user_id TO created_by;`，若列已存在则跳过）；`Category` 同样新增 `created_by`

## 非目标（本 spec 不做）
- 细粒度自定义角色（仅固定三角色，自定义角色预留字段不实现 UI）
- 第三方 OAuth/SSO（LDAP/Google/GitHub，预留接口不实现）
- 邮箱验证 / 找回密码（MVP 不引入邮件服务）
- 多租户隔离
- 双因素认证 2FA
- 文档级 ACL 的精细化自定义权限矩阵（仅按角色 + 创建者判断，不做"对指定用户授权"的 UI）

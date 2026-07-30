# Tasks

## 阶段一：依赖与数据模型
- [x] Task 1: 安装后端依赖
  - [x] SubTask 1.1: 在 `server/package.json` 新增依赖：`@nestjs/jwt @nestjs/passport passport passport-jwt bcryptjs`，devDeps：`@types/passport-jwt @types/bcryptjs`
  - [x] SubTask 1.2: 在 `server/` 运行 `pnpm install`（已成功安装）
- [x] Task 2: User 实体与模块
  - [x] SubTask 2.1: `server/src/users/user.entity.ts`：id/email/username/passwordHash(select:false)/role/status/createdAt/updatedAt
  - [x] SubTask 2.2: `server/src/users/users.module.ts`、`users.service.ts`、`users.controller.ts` 骨架
  - [x] SubTask 2.3: `users.service.ts` 实现 `seedIfEmpty()`：首次启动创建 admin@lxdoc.local / lxdoc12345（bcrypt 哈希），role=admin
- [x] Task 3: AuditLog 实体
  - [x] SubTask 3.1: `server/src/audit/audit-log.entity.ts`：id/userId/action/targetType/targetId/detail(jsonb)/ip/userAgent/createdAt
  - [x] SubTask 3.2: `server/src/audit/audit.module.ts`、`audit.service.ts`、`audit.controller.ts` 骨架
  - [x] SubTask 3.3: `audit.service.ts` 实现 `log(userId, action, target?, detail?)` 异步写入（不阻塞主流程）
- [x] Task 4: 数据库迁移：created_by 字段
  - [x] SubTask 4.1: `Document` 实体：将原 `userId` 改为 `createdBy`（保留 nullable，加 @Index）
  - [x] SubTask 4.2: `Category` 实体新增 `createdBy`（uuid nullable，加 @Index）
  - [x] SubTask 4.3: `app.module.ts` 的 `onApplicationBootstrap` 增加迁移 SQL：`ALTER TABLE documents RENAME COLUMN user_id TO created_by;`（try/catch，已存在则跳过）+ `ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by uuid`

## 阶段二：认证模块（JWT 双 token）
- [x] Task 5: AuthModule 实现
  - [x] SubTask 5.1: `server/src/auth/auth.module.ts`、`auth.service.ts`、`auth.controller.ts`、`strategies/jwt.strategy.ts`
  - [x] SubTask 5.2: `auth.service.ts`：login/refresh/logout/register/changePassword + 内存 Map 维护 refreshTokens
  - [x] SubTask 5.3: `jwt.strategy.ts`: 从 Authorization Bearer 解析 access token，拒绝 refresh token
  - [x] SubTask 5.4: `auth.controller.ts` 路由：login/register/refresh/logout/change-password（change-password 加 per-route JwtAuthGuard，阶段三改全局）
  - [x] SubTask 5.5: `server/src/common/guards/jwt-auth.guard.ts` + `@Public()` + `@CurrentUser()` 装饰器
- [x] Task 6: 配置项
  - [x] SubTask 6.1: `server/src/config/auth.config.ts`：JWT_SECRET/JWT_ACCESS_EXPIRES/JWT_REFRESH_EXPIRES/ALLOW_SIGNUP
  - [x] SubTask 6.2: `server/.env.example` 增加上述变量

## 阶段三：RBAC 与 ACL
- [x] Task 7: 角色守卫
  - [x] SubTask 7.1: `server/src/common/decorators/roles.decorator.ts`：`@Roles()` 元数据装饰器
  - [x] SubTask 7.2: `server/src/common/guards/roles.guard.ts`：从 `req.user.role` 判断，无 `@Roles` 装饰器则放行
  - [x] SubTask 7.3: `@CurrentUser()` 装饰器已在阶段二创建
- [x] Task 8: 全局守卫注册
  - [x] SubTask 8.1: `app.module.ts` 注册两个 `APP_GUARD`（JwtAuthGuard 先、RolesGuard 后）
  - [x] SubTask 8.2: `auth.controller.ts` 公开方法加 `@Public()`，change-password 走全局守卫 + `@CurrentUser('id')`
  - [x] SubTask 8.3: `health.controller.ts` 已加 `@Public()`
- [x] Task 9: 资源级 ACL
  - [x] SubTask 9.1: `documents.service.ts` 的 update/rollback 经 assertCanWrite 校验（admin 全权 / editor 仅 createdBy）
  - [x] SubTask 9.2: `categories.service.ts` 的 create/update/remove 同样增加创建者校验
  - [x] SubTask 9.3: `uploads.controller.ts` 类级 `@Roles(ADMIN,EDITOR)` + `@CurrentUser()`，ingest 传 user.id 填充 createdBy
  - [x] SubTask 9.4: `documents.controller.ts` update/rollback 加 `@Roles(ADMIN,EDITOR)` + `@CurrentUser()`，删除创建者本人在 service 内判断
  - [x] SubTask 9.5: 所有 controller 的 service 方法签名增加 `currentUser` 参数（调用方同步更新）

## 阶段四：用户管理 API
- [x] Task 10: 用户管理 CRUD
  - [x] SubTask 10.1: `users.controller.ts`：GET/POST/PATCH/DELETE 四个路由，类级 `@Roles(ADMIN)`
  - [x] SubTask 10.2: `users.service.ts`：findAll/create/update（防误锁）/remove（不能删自己、不能删最后一个 admin）
  - [x] SubTask 10.3: 所有路由 `@Roles(ADMIN)`
  - [x] SubTask 10.4: DTOs：CreateUserDto/UpdateUserDto/UserResponseDto

## 阶段五：审计日志接入
- [x] Task 11: 审计拦截器
  - [x] SubTask 11.1: `server/src/audit/audit.interceptor.ts`：全局拦截器，对带 `@Audit()` 装饰器的 controller 方法在成功后异步写日志，从 req 取 user/ip/userAgent
  - [x] SubTask 11.2: `server/src/common/decorators/audit.decorator.ts`：`@Audit('document_create')` 标注动作类型
  - [x] SubTask 11.3: `app.module.ts` 注册 `APP_INTERCEPTOR` = AuditInterceptor
  - [x] SubTask 11.4: 在 documents/categories/uploads/users/auth controller 的关键方法上加 `@Audit()` 装饰器
- [x] Task 12: 审计查询 API
  - [x] SubTask 12.1: `audit.controller.ts`：`GET /api/audit?userId=&action=&startDate=&endDate=&page=&pageSize=`，加 `@Roles('admin')`
  - [x] SubTask 12.2: `audit.service.ts` 实现 `findAll(query)` 分页查询

## 阶段六：前端登录与权限
- [x] Task 13: 前端 auth API 与状态
  - [x] SubTask 13.1: `web/src/api/auth.ts`：`login(email,password)`、`register(dto)`、`refresh(token)`、`logout()`、`changePassword(old,new)`
  - [x] SubTask 13.2: `web/src/stores/auth.ts`（Pinia）：state `{ user, accessToken, refreshToken }`，actions `login`/`logout`/`refresh`/`setTokens`，getter `isAdmin`/`isEditor`/`canWrite`
  - [x] SubTask 13.3: token 持久化到 `localStorage`（access + refresh + user），启动时从 localStorage 恢复
- [x] Task 14: axios 拦截器
  - [x] SubTask 14.1: `web/src/api/client.ts`：请求拦截器注入 `Authorization: Bearer ${accessToken}`
  - [x] SubTask 14.2: 响应拦截器：401 时若不是 refresh 请求，调用 `refresh(refreshToken)`，成功则重放原请求，失败则清空 store + 跳 `/login`
  - [x] SubTask 14.3: 防并发 refresh：用 promise 队列避免多次 401 同时触发多个 refresh
- [x] Task 15: 登录页与路由守卫
  - [x] SubTask 15.1: `web/src/views/LoginView.vue`：登录表单（email+password），支持 `?redirect=` query
  - [x] SubTask 15.2: `web/src/router/index.ts` 新增 `/login` 路由，添加 `router.beforeEach` 守卫：未登录访问受保护路由跳 `/login?redirect=`；已登录访问 `/login` 跳首页
  - [x] SubTask 15.3: 路由 meta：`/admin/*` 标 `meta: { roles: ['admin'] }`，守卫校验角色
- [x] Task 16: 用户菜单与布局
  - [x] SubTask 16.1: `web/src/App.vue` 顶部栏右侧加用户下拉菜单（el-dropdown）：显示用户名 + 头像首字母
  - [x] SubTask 16.2: 菜单项：修改密码（弹 el-dialog）、退出登录、（admin）用户管理、（admin）审计日志
  - [x] SubTask 16.3: 修改密码对话框：旧密码+新密码+确认密码，调用 `changePassword`，成功后退出登录要求重新登录
- [x] Task 17: 用户管理页
  - [x] SubTask 17.1: `web/src/views/admin/UsersView.vue`：el-table 列（email/username/role/status/createdAt）+ 分页 + 操作列（改角色、启用/禁用、删除）
  - [x] SubTask 17.2: 顶部"新建用户"按钮，弹 el-dialog（email/username/password/role）
  - [x] SubTask 17.3: `web/src/api/users.ts`：`listUsers(page,pageSize)`、`createUser(dto)`、`updateUser(id,dto)`、`deleteUser(id)`
- [x] Task 18: 审计日志页
  - [x] SubTask 18.1: `web/src/views/admin/AuditView.vue`：筛选区（用户/action 下拉/时间范围）+ el-table + 分页
  - [x] SubTask 18.2: `web/src/api/audit.ts`：`listAudit(query)`
- [x] Task 19: 路由与权限指令
  - [x] SubTask 19.1: `web/src/router/index.ts` 新增 `/admin/users`、`/admin/audit` 路由，meta.roles=['admin']
  - [x] SubTask 19.2: `web/src/directives/permission.ts`：`v-permission="'admin'"` 指令，无权限时移除元素
  - [x] SubTask 19.3: `web/src/main.ts` 注册指令
  - [x] SubTask 19.4: 顶部栏"上传文档"按钮加 `v-permission="['editor','admin']"`（viewer 隐藏）

## 阶段七：联调与验证
- [x] Task 20: 端到端验证（静态部分完成；运行时部分受 CI 环境约束，已标注所需环境）
  - [x] SubTask 20.1: 后端 `pnpm build` 通过
  - [x] SubTask 20.2: 前端 `pnpm build` 通过
  - [x] SubTask 20.3: 静态校验：所有 controller 路由有正确的 `@Public()` 或 `@Roles()` 装饰器
  - [x] SubTask 20.4: 静态校验：default admin 凭据、ALLOW_SIGNUP=false 默认值、JWT_SECRET 配置项
  - [ ] SubTask 20.5: 运行时验证（需 postgres + docker）：登录 → 上传（editor 可/admin 可/viewer 拒）→ 编辑他人文档（editor 拒）→ 删除（admin 可/创建者可）→ 用户管理（仅 admin）→ 审计日志可见 → token 过期自动 refresh
  - 备注：本机 CI 环境约束下（无 postgres、无 docker 守护进程）已完成全部静态验证（前后端编译通过、所有 controller 守卫配置正确、关键代码逻辑符合 spec、API 路由完整、配置项正确）。运行时验证需在部署环境执行。

# Task Dependencies
- Task 2 依赖 Task 1
- Task 5 依赖 Task 2
- Task 7 依赖 Task 5
- Task 8 依赖 Task 5、Task 7
- Task 9 依赖 Task 7、Task 8
- Task 10 依赖 Task 2、Task 7
- Task 11 依赖 Task 3、Task 7
- Task 12 依赖 Task 11
- Task 13 依赖 Task 5（后端 API 契约）
- Task 14 依赖 Task 13
- Task 15 依赖 Task 13、Task 14
- Task 16 依赖 Task 15
- Task 17 依赖 Task 10、Task 16
- Task 18 依赖 Task 12、Task 16
- Task 19 依赖 Task 17、Task 18
- Task 20 依赖所有前置任务

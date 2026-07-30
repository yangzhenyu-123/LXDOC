# Checklist

## 阶段一：依赖与数据模型
- [x] `server/package.json` 新增 `@nestjs/jwt @nestjs/passport passport passport-jwt bcryptjs`，devDeps `@types/passport-jwt @types/bcryptjs`
- [x] `pnpm install` 成功（已安装）
- [x] `User` 实体字段齐全：id/email/username/passwordHash(select:false)/role/status/createdAt/updatedAt
- [x] `AuditLog` 实体字段齐全：id/userId/action/targetType/targetId/detail(jsonb)/ip/userAgent/createdAt
- [x] `Document` 实体 `userId` 已改名为 `createdBy`，nullable，有索引
- [x] `Category` 实体新增 `createdBy` 字段
- [x] 启动时自动 seed admin@lxdoc.local / lxdoc12345，日志提示改密码

## 阶段二：认证模块
- [x] `POST /api/auth/login` 返回 `{ accessToken, refreshToken, user }`
- [x] access token 15min，refresh token 7d
- [x] 凭据错误返回 401，不区分用户不存在与密码错误
- [x] `POST /api/auth/refresh` 用 refresh token 换新 access token
- [x] `POST /api/auth/logout` 使 refresh token 失效
- [x] `PATCH /api/auth/change-password` 校验旧密码后更新，使所有 refresh token 失效
- [x] `POST /api/auth/register` 受 `ALLOW_SIGNUP` 控制，默认 false 返回 403
- [x] ALLOW_SIGNUP=true 时新注册用户默认 role=viewer
- [x] JWT_SECRET 可通过 env 配置，默认值带警告提示
- [x] `.env.example` 含 JWT_SECRET/JWT_ACCESS_EXPIRES/JWT_REFRESH_EXPIRES/ALLOW_SIGNUP

## 阶段三：RBAC 与 ACL
- [x] `@Roles()` 装饰器 + `RolesGuard` 实现角色校验
- [x] `@CurrentUser()` 装饰器从 req.user 注入当前用户
- [x] `@Public()` 装饰器排除 login/register/health
- [x] 全局 `APP_GUARD` = JwtAuthGuard，所有接口默认需登录
- [x] `/api/documents`、`/api/categories`、`/api/uploads`、`/api/search` GET 接口需 viewer+
- [x] 写操作（POST/PUT/PATCH/DELETE）需 editor+（`@Roles('admin','editor')`）
- [x] editor 只能修改自己 `createdBy` 的文档/分类，admin 全权
- [x] viewer 调用写接口返回 403
- [x] editor 修改他人资源返回 403
- [x] 上传接口填充 `createdBy = currentUser.id`
- [x] 文档删除接口 `DELETE /api/documents/:id`：admin 全权，editor 仅删自己创建的

## 阶段四：用户管理
- [x] `GET /api/users` 分页返回用户列表（不含 passwordHash）
- [x] `POST /api/users` admin 创建用户（不受 ALLOW_SIGNUP 限制）
- [x] `PATCH /api/users/:id` 改 role/status/username
- [x] `DELETE /api/users/:id` 拒绝删自己、拒绝删最后一个 admin
- [x] 不能把自己降级或禁用（防误锁）
- [x] 所有用户管理接口 `@Roles('admin')`

## 阶段五：审计日志
- [x] `AuditInterceptor` 对 `@Audit()` 标注的方法成功后异步写日志
- [x] 审计记录含 userId/action/targetType/targetId/detail/ip/userAgent/createdAt
- [x] 关键操作均加 `@Audit()`：登录/登出/文档CRUD/分类CRUD/用户CRUD/改密码
- [x] `GET /api/audit` 支持按 userId/action/时间范围/分页筛选
- [x] 审计查询接口 `@Roles('admin')`

## 阶段六：前端登录与权限
- [x] `/login` 登录页，表单含 email+password，支持 `?redirect=` query
- [x] Pinia auth store 持久化到 localStorage（access+refresh+user）
- [x] axios 请求拦截器自动注入 `Authorization: Bearer`
- [x] axios 401 响应拦截器自动调用 refresh，成功重放原请求
- [x] refresh 失败清空 store 并跳 `/login`
- [x] 防并发 refresh（promise 队列）
- [x] router beforeEach 守卫：未登录跳 `/login?redirect=`
- [x] `/admin/*` 路由 meta.roles=['admin']，守卫校验
- [x] 顶部栏右侧用户下拉菜单（用户名 + 头像首字母）
- [x] 菜单含：修改密码（弹窗）、退出登录
- [x] admin 菜单额外含：用户管理、审计日志入口
- [x] 修改密码成功后退出登录要求重新登录
- [x] `/admin/users` 页：el-table + 分页 + 新建/改角色/启停/删除
- [x] `/admin/audit` 页：筛选 + el-table + 分页
- [x] `v-permission` 指令实现，viewer 隐藏"上传文档"按钮
- [x] 文档列表页删除按钮：admin 可删任意，editor 仅删自己创建的

## 阶段七：联调与验证
- [x] 后端 `pnpm build` 通过
- [x] 前端 `pnpm build` 通过
- [x] 静态校验：所有 controller 路由有 `@Public()` 或被 JwtAuthGuard 覆盖
- [x] 静态校验：default admin 凭据与日志提示
- [x] 静态校验：JWT_SECRET/ALLOW_SIGNUP 默认值
- [ ] 运行时验证：登录→上传→编辑他人文档拒→删除→用户管理→审计日志→token refresh（待运行时环境：postgres + docker）

## 文档与可维护性
- [x] `server/.env.example` 含全部新增环境变量
- [x] 原 init-enterprise-kb spec 保留，本 spec 作为 delta 共存
- [x] README 更新默认管理员凭据与首次登录提示

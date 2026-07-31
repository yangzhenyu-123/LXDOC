# API 参考

全局前缀 `/api`（`/health` 除外）。除标注 `@Public` 的接口外，所有接口需 `Authorization: Bearer <accessToken>`。

权限标注：`🔑登录`（任意登录用户）、`👤admin`、`✏️editor+`（admin/editor）、`🌐公开`。

## 交互式调试（Swagger UI）

部署后可直接在浏览器打开交互式 API 调试文档，在线发送请求调试全部接口：

- 调试入口：`http://<后端地址>/api/docs`（compose 部署经 nginx 反代为 `http://localhost:8080/api/docs`）
- 鉴权：点击页面右上角 `Authorize`，填入 `Bearer <accessToken>`（先调 `POST /api/auth/login` 获取 accessToken）
- 原始 OpenAPI JSON：`/api/docs-json`；YAML：`/api/docs-yaml`，可导入 Postman/Apifox

> 启用开关 `ENABLE_API_DOCS`：开发环境（`NODE_ENV !== production`）默认开启；**生产环境默认关闭**，需显式设置 `ENABLE_API_DOCS=true` 才开启，避免接口结构对外泄露。配置方式见 [部署指南](./deployment.md)。

下方为手工维护的接口速查表，与 Swagger 自动生成文档内容一致，可作快速浏览用。



## 认证 Auth

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/auth/login` | 🌐 | 登录，返回 `{ accessToken, refreshToken, user }` |
| POST | `/api/auth/register` | 🌐 | 自注册（受 `ALLOW_SIGNUP` 控制，默认关闭） |
| POST | `/api/auth/refresh` | 🌐 | 用 refreshToken 换新 accessToken |
| POST | `/api/auth/logout` | 🌐 | 使指定 refreshToken 失效 |
| PATCH | `/api/auth/change-password` | 🔑 | 修改当前用户密码 |

## 用户 Users

所有接口仅 admin。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/users?page=&pageSize=` | 分页用户列表 |
| POST | `/api/users` | 创建用户 |
| PATCH | `/api/users/:id` | 更新用户（不能降级/禁用自己） |
| DELETE | `/api/users/:id` | 删除用户（不能删自己、不能删最后一个 admin） |

## 组织 Organizations

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/organizations` | 🔑 | 组织树（扁平列表，前端构建树） |
| POST | `/api/organizations` | ✏️ | 新建节点（顶层部门仅 admin；子节点需父节点管理权） |
| PATCH | `/api/organizations/:id` | ✏️ | 改名/排序（需该节点管理权） |
| DELETE | `/api/organizations/:id` | ✏️ | 删除节点（需管理权，无子节点无文档） |
| GET | `/api/organizations/:id/members` | ✏️ | 成员列表（需该节点管理权） |
| POST | `/api/organizations/:id/members` | ✏️ | 添加成员（body: `{ userId, role }`） |
| PATCH | `/api/organizations/:id/members/:userId` | ✏️ | 改成员角色 |
| DELETE | `/api/organizations/:id/members/:userId` | ✏️ | 移除成员 |

> 成员角色变更后服务端会失效该用户的权限缓存（`invalidateUserCache`），30s 内全局生效。

## 分类 Categories

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/categories` | 🔑 | 分类树 |
| GET | `/api/categories/:id` | 🔑 | 单个分类 |
| POST | `/api/categories` | ✏️ | 创建分类（可挂 organizationId） |
| PATCH | `/api/categories/:id` | ✏️ | 更新分类（editor 仅自己的） |
| DELETE | `/api/categories/:id` | ✏️ | 删除分类（editor 仅自己的） |

## 文档 Documents

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/documents/recent?limit=` | 🔑 | 最近更新文档（不含 content，按读权限过滤） |
| GET | `/api/documents/:id` | 🔑 | 获取文档（含 content，校验读权限） |
| PUT | `/api/documents/:id` | ✏️ | 更新文档（写版本快照，version+1，需写权限） |
| DELETE | `/api/documents/:id` | ✏️ | 删除文档（需写权限，best-effort 清理磁盘文件） |
| GET | `/api/documents/:id/versions` | 🔑 | 版本列表（不含 content） |
| GET | `/api/documents/:id/versions/:v` | 🔑 | 某版本内容 |
| POST | `/api/documents/:id/rollback/:v` | ✏️ | 回滚到某版本（version+1，不破坏历史） |
| GET | `/api/categories/:id/documents?includeChildren=` | 🔑 | 分类下文档列表 |
| GET | `/api/documents/:id/preview` | 🔑 | docx/odt 的 pandoc HTML 预览片段 |
| GET | `/api/documents/:id/pdf-html` | 🔑 | PDF 版式保真 HTML（pdf2htmlEX，带缓存） |
| POST | `/api/documents/:id/convert-to-editable` | ✏️ | PDF 转可编辑 md（生成新文档，原 PDF 保留） |
| GET | `/api/documents/:id/onlyoffice/config?mode=edit\|view` | 🔑 | OnlyOffice 初始化 config（含 JWT token） |
| POST | `/api/documents/:id/onlyoffice/callback` | 🌐 | OnlyOffice 保存回调（JWT 校验，返回 `{error:0\|1}`） |

### OnlyOffice config 响应示例

```json
{
  "documentType": "word",
  "document": {
    "fileType": "docx",
    "key": "<docId>#v3",
    "title": "文档标题.docx",
    "url": "http://backend:3000/api/files/<id>/original?token=<shortLived>",
    "permissions": { "edit": true, "download": true, "print": true, "review": true }
  },
  "editorConfig": {
    "mode": "edit",
    "callbackUrl": "http://backend:3000/api/documents/<id>/onlyoffice/callback",
    "lang": "zh",
    "user": { "id": "<userId>", "name": "<userId>" },
    "customization": { "forcesave": true, "autosave": true }
  },
  "token": "<jwt-of-config>"
}
```

## 上传 Uploads

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/uploads` | ✏️ | 上传文档（multipart `file`，body: `{ categoryId, ownerType?, ownerId? }`） |
| POST | `/api/uploads/image` | ✏️ | 上传图片（multipart `file`，body: `{ docId? }`） |

上传文档返回 `{ id, title, format, version, categoryId, ownerType, ownerId }`。
上传图片返回 `{ url, filename }`，`url` 为 `/api/files/:docId/image/:name`（无 token，前端按需拼接）。

## 文件 Files

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/files/token/:docId` | 🔑 | 签发短期文件 token（校验读权限） |
| GET | `/api/files/:docId/original?token=` | 🌐 | 下载原文件（校验 token） |
| GET | `/api/files/:docId/image/:name?token=` | 🌐 | 下载图片（校验 token，防路径穿越） |

token 默认 10 分钟有效，绑定 docId。

## 检索 Search

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/search?q=&page=&pageSize=` | 🔑 | 全文检索（pg_trgm，按读权限过滤） |

## 审计 Audit

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/audit?userId=&action=&startDate=&endDate=&page=&pageSize=` | 👤 | 审计日志分页查询 |

## LLM

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/llm/health` | 👤 | LLM Provider 就绪状态与配置（apiKey 脱敏） |

## 健康检查

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/health` | 🌐 | 后端存活探活（无 `/api` 前缀） |

## 统一响应与错误

- 成功：直接返回数据对象 / 数组 / 无 body（204 隐含）
- 错误：NestJS 默认 `{ statusCode, message, error }`，HTTP 状态码语义：
  - `400` 参数校验失败（ValidationPipe）
  - `401` 未登录 / token 失效
  - `403` 权限不足（角色或 ACL）
  - `404` 资源不存在
  - `500` 服务端错误（如 pdf2htmlEX 未安装）

## 审计自动记录

带 `@Audit(action, resource)` 装饰器的接口在成功返回后自动写审计日志，无需业务代码手动调用。详见 [architecture.md#全局守卫与拦截器](./architecture.md#全局守卫与拦截器)。

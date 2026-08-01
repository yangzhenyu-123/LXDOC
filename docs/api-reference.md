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
| GET | `/api/documents/knowledge-tree` | 🔑 | AI 知识库文档列表（列出所有 AI 总结文档，含 knowledgePath，前端构建树） |
| GET | `/api/documents/my` | 🔑 | 我创建的文档列表 |
| GET | `/api/documents/favorites` | 🔑 | 当前用户收藏的文档列表 |
| GET | `/api/documents/my-org` | 🔑 | 当前用户组织范围内的文档列表 |
| GET | `/api/documents/tags` | 🔑 | 标签列表（用于标签筛选） |
| GET | `/api/documents/:id` | 🔑 | 获取文档（含 content，校验读权限） |
| PUT | `/api/documents/:id` | ✏️ | 更新文档（写版本快照，version+1，需写权限） |
| DELETE | `/api/documents/:id` | ✏️ | 删除文档（需写权限，best-effort 清理磁盘文件） |
| POST | `/api/documents/:id/favorite` | 🔑 | 切换收藏状态（已收藏则取消，返回 `{ favored: boolean }`） |
| GET | `/api/documents/:id/versions` | 🔑 | 版本列表（不含 content） |
| GET | `/api/documents/:id/versions/:v` | 🔑 | 某版本内容 |
| POST | `/api/documents/:id/rollback/:v` | ✏️ | 回滚到某版本（version+1，不破坏历史） |
| GET | `/api/categories/:id/documents?includeChildren=` | 🔑 | 分类下文档列表 |
| GET | `/api/documents/:id/preview` | 🔑 | pandoc HTML 预览片段（仅限 pandoc 可转的 word 类格式，kkFileView 兜底） |
| GET | `/api/documents/:id/pdf-html` | 🔑 | PDF 版式保真 HTML（pdf2htmlEX，带缓存） |
| GET | `/api/documents/:id/kkview` | 🔑 | kkFileView 预览 URL（未启用时返回 503，前端回退 pdf-html/pandoc） |
| POST | `/api/documents/:id/convert-to-editable` | ✏️ | PDF 转可编辑 md（生成新文档，原 PDF 保留） |
| GET | `/api/documents/:id/onlyoffice/config?mode=edit\|view` | 🔑 | OnlyOffice 初始化 config（word/cell/slide 三类，含 JWT token） |
| POST | `/api/documents/:id/onlyoffice/callback` | 🌐 | OnlyOffice 保存回调（JWT 校验，返回 `{error:0\|1}`） |
| POST | `/api/documents/:id/summarize` | ✏️ | 触发 AI 总结：基于当前文档生成 Docsify 风格 markdown 总结文档 |

> `/api/documents/knowledge-tree` 必须声明在 `/api/documents/:id` 之前，否则 `knowledge-tree` 会被 `:id` 匹配（已在 controller 中正确排序）。

### 文档附件 Attachments

附件挂在主文档下，分 file 类型（落盘附件文件）与 document 类型（引用集合成员）两类。所有附件路由前缀 `/api/documents/:docId/attachments`，附件权限继承主文档。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/documents/:docId/attachments` | 🔑 | 附件列表（含 union 集合共享附件，按读权限过滤） |
| POST | `/api/documents/:docId/attachments/file` | ✏️ | 上传 file 类型附件（multipart `file`，body: `{ sort? }`） |
| POST | `/api/documents/:docId/attachments/document` | ✏️ | 添加 document 类型附件（body: `{ linkedDocumentId, sort? }`，主文档需为集合） |
| PUT | `/api/documents/:docId/attachments/:attachId/sort` | ✏️ | 更新附件排序（body: `{ sort }`） |
| DELETE | `/api/documents/:docId/attachments/:attachId` | ✏️ | 删除附件（file 类型同时清理磁盘文件；document 类型即从集合移除成员） |
| GET | `/api/documents/:docId/attachments/:attachId/kkview` | 🔑 | 附件 kkFileView 预览 URL（仅 file 类型） |
| GET | `/api/documents/:docId/attachments/:attachId/download?token=` | 🌐 | 附件文件下载（@Public，token 按主文档 id 签发，仅 file 类型） |

> 集合（`documents.is_collection=true`）的 document 类型附件即集合成员；列出附件时若该文档被某集合引用为成员，会自动 union 该集合主文档的 file 类型附件（实现「集合共享附件」）。附件下载 token 与原文件下载 token 使用同一签发机制，但路由不同，便于权限审计区分。

### OnlyOffice config 响应示例

```json
{
  "documentType": "word",
  "document": {
    "fileType": "docx",
    "key": "<docId>_v3",
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

`documentType` 按格式映射：word（doc/docx/dot/dotm/dotx/odt/ott/rtf/txt/md/wps/wpt/ofd）、cell（xls/xlsx/xlsm/xlt/xltm/xlam/ods/ots/fods/et/ett/csv/tsv）、slide（ppt/pptx/pptm/odp/otp/dps）。`document.key` 用 `<docId>_v<version>`，版本变化强制重载。

## 上传 Uploads

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/uploads` | ✏️ | 上传文档（multipart `file`，body: `{ categoryId, ownerType?, ownerId?, isCollection? }`） |
| POST | `/api/uploads/collection` | ✏️ | 创建文档集主文档（无文件，body: `{ categoryId, title, memberDocIds: string[], ownerType?, ownerId? }`，`memberDocIds` 必填） |
| POST | `/api/uploads/image` | ✏️ | 上传图片（multipart `file`，body: `{ docId? }`） |

上传文档返回 `{ id, title, format, version, categoryId, ownerType, ownerId, isCollection }`。
上传文档集返回 `{ id, title, format, isCollection: true, categoryId, ... }`，`memberDocIds` 中的文档会被自动引用为集合的 document 类型附件。
上传图片返回 `{ url, filename }`，`url` 为 `/api/files/:docId/image/:name`（无 token，前端按需拼接）。

> `POST /api/uploads` 也支持 `isCollection=true` 把带文件的文档标记为集合（边缘用法，通常用 `/uploads/collection` 创建无文件集合）。

## 文件 Files

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/files/token/:docId` | 🔑 | 签发短期文件 token（校验读权限） |
| GET | `/api/files/:docId/original?token=` | 🌐 | 下载原文件（校验 token） |
| GET | `/api/files/:docId/image/:name?token=` | 🌐 | 下载图片（校验 token，防路径穿越） |

token 默认 10 分钟有效，绑定 docId。附件下载走独立路由 `/api/documents/:docId/attachments/:attachId/download?token=`（见上文附件章节），同样按主文档 id 签发 token，便于权限审计区分。

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
| GET | `/api/llm/health` | 👤 | LLM Provider 就绪状态与系统配置（apiKey 脱敏） |
| GET | `/api/llm/my-config` | 🔑 | 当前用户 LLM 配置（apiKey 脱敏为 `******`，含 actAsUserId/enableThinking） |
| PUT | `/api/llm/my-config` | 🔑 | 更新当前用户 LLM 配置（body: `{ baseUrl?, apiKey?, model?, enableThinking?, actAsUserId? }`，apiKey 传 `******` 视为不修改） |
| GET | `/api/llm/users-overview` | 👤 | admin 查看所有用户的 LLM 配置摘要（apiKey 脱敏，用于运维排查 LLM 接入异常） |

> 用户级 LLM 配置优先于系统配置；admin 未配置用户级时自动回退到系统配置。详见 [llm.md#用户级配置](./llm.md#用户级配置)。

## 系统配置 System

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/system/config` | 🔑 | 返回运行时系统配置（LLM/OnlyOffice/kkFileView/docling/auth/upload，敏感项脱敏） |
| GET | `/api/system/settings` | 👤 | 可改配置项清单（14 项，含分组/类型/当前脱敏值） |
| PUT | `/api/system/config` | 👤 | 批量更新系统配置（body: `{ items: [{ key, value }, ...] }`，写入即生效） |

`PUT /api/system/config` 约束：

- 仅 admin 可调用
- DTO 必须使用 class-validator 装饰器（全局 ValidationPipe 启用 `forbidNonWhitelisted`）
- 敏感项（apiKey 等）传 `******` 视为不修改
- 写入 `system_settings` 表 + 同步内存覆盖层（`settings-overrides.ts`），无需重启立即生效
- 14 项可改配置见 [deployment.md#系统配置项](./deployment.md#可在线修改的配置项)

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

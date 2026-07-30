# 系统架构

本文描述 LXDOC 的整体架构、模块划分、数据模型与请求流转。

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器（Vue3 SPA）                      │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Vditor    │  │ OnlyOffice   │  │ pdfjs / 版式 HTML 预览  │  │
│  │ md/txt编辑│  │ docx 真编辑  │  │ PDF 翻页 / 版式预览     │  │
│  └──────────┘  └──────┬───────┘  └────────────────────────┘  │
│                       │ iframe + api.js                       │
└───────────────────────┼──────────────────────────────────────┘
                        │ /api  /onlyoffice  (同源经 nginx 反代)
┌───────────────────────┼──────────────────────────────────────┐
│              nginx (frontend 容器 8080)                        │
│   /api/*       → backend:3000                                  │
│   /onlyoffice/ → onlyoffice:80    (WebSocket)                  │
└───────────────────────┼──────────────────────────────────────┘
                        │
        ┌───────────────┴────────────────┐
        ▼                                ▼
┌──────────────────────┐        ┌──────────────────────┐
│  backend (NestJS)     │        │  OnlyOffice Doc      │
│  /api/*               │◄───────│  Server (80)         │
│  - auth/users/audit   │ 回调   │  - JWT 校验           │
│  - organizations/ACL   │ POST   │  - 拉取 docx 文件     │
│  - documents/版本      │ /callback  │  - 保存新文件回写   │
│  - uploads/parsers     │        └──────────────────────┘
│  - files 签名鉴权      │
│  - search (pg_trgm)   │
│  - llm (Provider抽象)  │
└─────────┬────────────┘
          │
   ┌──────┴───────┬──────────────┐
   ▼              ▼              ▼
┌────────┐  ┌──────────┐  ┌──────────────┐
│PostgreSQL│ │ uploads/ │  │ 系统二进制     │
│ 16     │  │ original/│  │ pandoc        │
│+pg_trgm│  │ images/  │  │ pdf2htmlEX    │
│+GIN    │  │ cache/   │  │ soffice       │
└────────┘  └──────────┘  └──────────────┘
```

## 后端模块划分

所有模块位于 `server/src/`，全局路由前缀 `/api`（`health` 除外）。

| 模块 | 职责 | 关键文件 |
|---|---|---|
| `auth` | 注册/登录/登出/刷新/改密；JWT 双 token；JwtStrategy 注入 organizationId/orgPath | auth.service.ts、strategies/jwt.strategy.ts |
| `users` | 用户 CRUD、状态启停、组织分配 | users.service.ts、user.entity.ts |
| `organizations` | 组织树 CRUD、成员+角色管理、访问控制核心 | organizations.service.ts、access-control.service.ts |
| `categories` | 分类树 CRUD（可挂组织节点） | categories.service.ts |
| `documents` | 文档 CRUD、版本快照、回滚、OnlyOffice 集成、PDF 工具 | documents.service.ts、onlyoffice.service.ts、pdf-tools.service.ts |
| `uploads` | 文件上传、多格式解析器（md/txt/docx/odt/pdf） | uploads.service.ts、parsers/* |
| `files` | 原文件/图片签名 URL 鉴权下载 | files.service.ts、files.controller.ts |
| `search` | 全文检索（pg_trgm + GIN） | search.service.ts |
| `llm` | LLM Provider 抽象、GLM 实现、健康检查 | llm.service.ts、providers/glm.provider.ts |
| `audit` | 审计日志记录与查询（拦截器自动写入） | audit.interceptor.ts |
| `health` | 健康检查 `/health` | health.controller.ts |

### 全局守卫与拦截器

在 `app.module.ts` 中注册：

1. `JwtAuthGuard`（APP_GUARD）：先执行，校验 JWT；`@Public()` 装饰的接口跳过
2. `RolesGuard`（APP_GUARD）：后执行，校验 `@Roles()` 角色要求
3. `AuditInterceptor`（APP_INTERCEPTOR）：handler 成功返回后按 `@Audit()` 写审计日志

## 数据模型

### 核心实体关系

```
users 1───* organizations (organization_id)
       │
       └──* user_org_roles (user_id, org_id, role)

organizations (自引用树)
  parent_id → organizations.id
  path: <dept-uuid>[.<group-uuid>]*

categories (树)
  parent_id → categories.id
  organization_id → organizations.id (nullable，公共分类为 null)

documents
  category_id → categories.id
  created_by  → users.id
  owner_type  : personal | group | department
  owner_id    : personal→user.id；group/department→organization.id
  content_source : manual | pandoc | pdf_text | onlyoffice

document_versions
  document_id → documents.id
  version, content, snapshot_path
```

### 关键表

| 表 | 说明 |
|---|---|
| `users` | 用户，含 role（admin/editor/viewer）、organization_id、status |
| `organizations` | 组织树节点，type=department/group，path 物化路径 |
| `user_org_roles` | 用户在某组织节点的编辑授权（editor/admin） |
| `categories` | 分类树，可挂组织节点 |
| `documents` | 文档，含 format、owner_type/owner_id、content_source、version |
| `document_versions` | 版本快照，每次保存/回滚写一条 |
| `audit_logs` | 审计日志，action、resource、operator、ip、detail |

### 索引

- `documents.title` / `documents.content`：GIN trigram（`pg_trgm` 扩展），支持中文模糊检索
- `documents.(owner_type, owner_id)`、`documents.created_by`：权限过滤
- `organizations.path`、`organizations.parent_id`：树查询
- `users.email` / `users.username`：唯一索引

索引在 `AppModule.onApplicationBootstrap` 中通过原始 SQL 创建（`CREATE INDEX IF NOT EXISTS`）。

## 请求流转示例

### 打开一篇 docx 文档（OnlyOffice 编辑）

```
1. 浏览器 GET /api/documents/:id           → 拿到文档元信息（format=docx）
2. 浏览器 GET /api/documents/:id/onlyoffice/config?mode=edit
   ├─ OnlyOfficeService.buildConfig
   │   ├─ findOne → AccessControl.assertCanRead
   │   ├─ canWrite → 决定 mode=edit/view
   │   ├─ filesService.signFileToken(docId, userId)  → 短期 file token
   │   ├─ fileUrl = BACKEND_PUBLIC_URL/api/files/:id/original?token=...
   │   ├─ callbackUrl = BACKEND_PUBLIC_URL/api/documents/:id/onlyoffice/callback
   │   └─ jwtService.sign(config, onlyofficeConfig.jwtSecret) → config.token
   └─ 返回 config（含 token）
3. 浏览器注入 /onlyoffice/web-apps/.../api.js → new DocsAPI.DocEditor(el, config)
4. OnlyOffice 容器用 fileUrl 拉取 docx（带 token，绕过 session 鉴权）
5. 用户编辑保存 → OnlyOffice POST /api/documents/:id/onlyoffice/callback
   ├─ verifyCallbackToken(payload.token, jwtSecret)
   ├─ status=2/6 → 下载 payload.url 覆盖 originalPath
   ├─ 写当前 content 快照 → version+1 → content_source='onlyoffice'
   └─ 异步 pandoc 重抽纯文本索引
6. 返回 {"error":0}
```

### 打开一篇 PDF 文档

```
1. GET /api/documents/:id  → format=pdf
2. 默认 tab=版式预览：GET /api/documents/:id/pdf-html
   └─ PdfToolsService.generateLayoutHtml → pdf2htmlEX 生成 → 缓存 cache/<docId>/pdf-v<version>.html
3. 翻页预览 tab：GET /api/files/token/:docId 拿 token → pdfjs 加载 /api/files/:id/original?token=
4. 编辑文本 tab：直接编辑 documents.content（pdf-parse 入库的全文）
5. 转可编辑按钮：POST /api/documents/:id/convert-to-editable
   └─ soffice PDF→docx → pandoc docx→markdown → 新建 md 文档 → 跳转
```

## 版本与快照策略

- 每次文档更新（PUT `/api/documents/:id`）或 OnlyOffice 保存回调时：
  1. 先把当前内容写入 `document_versions`（version=当前 version，已存在则跳过）
  2. 更新 `documents` 的 content，`version + 1`
- 回滚：把目标版本内容作为新版本写入（`version + 1`），不破坏历史
- OnlyOffice 的 `document.key = "<docId>#v<version>"`，版本变化时强制重新加载

## 安全设计要点

- 静态文件不裸暴露：`/uploads/*` 无静态路由，统一走 `/api/files/:docId/*?token=`，token 绑定 docId、短期有效
- 路径穿越防护：`FilesService.getImageAbsPath` 规范化后校验必须落在 `images/<docId>/` 内
- 参数化查询：读权限过滤 `readableScopeFilter` 用 TypeORM Brackets + 参数化，搜索用原生 SQL 参数化，防注入
- 密码哈希：bcryptjs，`select:false` 默认查询不返回，需校验时显式 addSelect
- OnlyOffice 回调 JWT 校验：用 `ONLYOFFICE_JWT_SECRET` 校验 `payload.token`

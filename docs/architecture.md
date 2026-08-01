# 系统架构

本文描述 LXDOC 的整体架构、模块划分、数据模型与请求流转。

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器（Vue3 SPA）                      │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Vditor    │  │ OnlyOffice   │  │ pdfjs / kkFileView 预览  │  │
│  │ md/txt编辑│  │ Office 真编辑│  │ PDF 双 tab / 130+ 格式  │  │
│  └──────────┘  └──────┬───────┘  └────────────────────────┘  │
│                       │ iframe + api.js                       │
│  ┌──────────────────┐ ┌──────────────────┐                    │
│  │ KnowledgeTree     │ │ ProfileView/      │                    │
│  │ AI 知识库树        │ │ SystemConfigView  │                    │
│  └──────────────────┘ └──────────────────┘                    │
└───────────────────────┼──────────────────────────────────────┘
                         │ /api  /onlyoffice  /kkview  (同源经 nginx 反代)
┌───────────────────────┼──────────────────────────────────────┐
│              nginx (frontend 容器 8080)                        │
│   /api/*       → backend:3000                                  │
│   /onlyoffice/ → onlyoffice:80   (WebSocket)                    │
│   /kkview/     → kkfileview:8012 (iframe)                        │
└───────────────────────┼──────────────────────────────────────┘
                         │
   ┌─────────────────────┴────────────────────────────────┐
   ▼                                                      ▼
┌──────────────────────┐                       ┌──────────────────────┐
│  backend (NestJS)     │   文件下载签名 URL      │  OnlyOffice Doc      │
│  /api/*               │◄─────────────────────│  Server (80)         │
│  - auth/users/audit   │   回调 POST /callback  │  - JWT 校验           │
│  - organizations/ACL   │                       │  - 拉取 office 文件   │
│  - documents/版本/附件  │                       └──────────────────────┘
│  - 收藏/知识树          │                                  ▲
│  - uploads/parsers     │   文件下载签名 URL                │ 同源反代 /kkview
│  - files 签名鉴权      │─────────────────────────────┐    │
│  - search (pg_trgm)   │                              │  ┌──────────────────────┐
│  - llm (Provider抽象)  │                              └──│  kkFileView 5.1.0     │
│  - llm-config (用户级) │                                 │  - LibreOffice 内置   │
│  - system (在线编辑)   │                                 │  - 100+ 格式预览      │
└─────────┬────────────┘                                 └──────────────────────┘
          │
   ┌──────┴───────┬──────────────┬──────────────┐
   ▼              ▼              ▼              ▼
┌────────┐  ┌──────────┐  ┌──────────────┐  ┌──────────────┐
│PostgreSQL│ │ uploads/ │  │ 系统二进制     │  │ docling-serve  │
│ 16     │  │ original/│  │ pandoc        │  │ (CPU sidecar)  │
│+pg_trgm│  │ images/  │  │ soffice       │  │ - 图片/表格/OCR │
│+GIN    │  │attach-   │  │               │  └────────────────┘
└────────┘  │ments/    │  └──────────────┘
            │cache/    │
            └──────────┘
                                   ┌──────────────────┐
                                   │  pdf2htmlEX       │
                                   │  sidecar (7000)   │
                                   │  kkFileView 回退   │
                                   └──────────────────┘

  ┌──────────────────┐
  │  backup 容器      │  cron 定时：pg_dump + tar 打包 uploads → /backups
  └──────────────────┘
```

## 后端模块划分

所有模块位于 `server/src/`，全局路由前缀 `/api`（`health` 除外）。

| 模块 | 职责 | 关键文件 |
|---|---|---|
| `auth` | 注册/登录/登出/刷新/改密；JWT 双 token；JwtStrategy 注入 organizationId/orgPath | auth.service.ts、strategies/jwt.strategy.ts |
| `users` | 用户 CRUD、状态启停、组织分配（含用户级 LLM 配置字段） | users.service.ts、user.entity.ts |
| `organizations` | 组织树 CRUD、成员+角色管理、访问控制核心 | organizations.service.ts、access-control.service.ts |
| `categories` | 分类树 CRUD（可挂组织节点） | categories.service.ts |
| `documents` | 文档 CRUD、版本快照、回滚、OnlyOffice 集成（word/cell/slide 三类 32 格式）、PDF 工具、附件管理、文档收藏、AI 知识树、AI 总结 | documents.service.ts、onlyoffice.service.ts、pdf-tools.service.ts、attachments.service.ts、attachments.controller.ts、document-attachment.entity.ts、document-favorite.entity.ts |
| `uploads` | 文件上传、文档集创建、多格式解析器（md/txt/csv/tsv/docx/odt/pdf） | uploads.service.ts、uploads.controller.ts、parsers/* |
| `files` | 原文件/图片签名 URL 鉴权下载 | files.service.ts、files.controller.ts |
| `search` | 全文检索（pg_trgm + GIN） | search.service.ts |
| `llm` | LLM Provider 抽象、GLM 实现、健康检查、用户级 LLM 配置（baseUrl/apiKey/model/enableThinking/actAsUserId） | llm.service.ts、providers/glm.provider.ts、llm-config.service.ts、llm-config.controller.ts、llm-config.entity.ts |
| `system` | 系统配置在线编辑（system_settings 覆盖层，14 项可改配置） | system.controller.ts、system-settings.service.ts、settings-overrides.ts、system-setting.entity.ts |
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
  content_source : manual | pandoc | pdf_text | onlyoffice | ai_summary | docling
  is_collection : boolean（标记文档集主文档）
  knowledge_path : varchar(500)（AI 总结文档的 LLM 生成分类路径，slash 分隔）
  source_doc_id  → documents.id（AI 总结指向原文档，可空）

document_attachments
  document_id          → documents.id（附件所属主文档）
  attach_type          : file | document
  file_path            : file 类型落盘路径 attachments/<docId>/<file>
  linked_document_id   → documents.id（document 类型引用的成员文档）

document_favorites
  user_id     → users.id
  document_id → documents.id
  UNIQUE(user_id, document_id)

document_versions
  document_id → documents.id
  version, content, snapshot_path

llm_configs（旧表，向后兼容保留）
  created_by → users.id

system_settings
  key (PK), value, value_type, updated_by

users 扩展字段（用户级 LLM 配置）
  llm_base_url / llm_api_key / llm_model
  llm_enable_thinking / llm_act_as_user_id / llm_config_id
```

### 关键表

| 表 | 说明 |
|---|---|
| `users` | 用户，含 role（admin/editor/viewer）、organization_id、status、用户级 LLM 配置字段 |
| `organizations` | 组织树节点，type=department/group，path 物化路径 |
| `user_org_roles` | 用户在某组织节点的编辑授权（editor/admin） |
| `categories` | 分类树，可挂组织节点 |
| `documents` | 文档，含 format（36 值 enum）、owner_type/owner_id、content_source、version、is_collection、knowledge_path、source_doc_id |
| `document_attachments` | 文档附件：file 类型落盘附件文件，document 类型引用集合成员 |
| `document_favorites` | 文档收藏关系（user × document 多对多） |
| `document_versions` | 版本快照，每次保存/回滚写一条 |
| `llm_configs` | 旧 LLM 配置套表（向后兼容，新架构改为用户级字段） |
| `system_settings` | 系统配置覆盖（key-value），admin 在线修改的运行时配置 |
| `audit_logs` | 审计日志，action、resource、operator、ip、detail |

### 索引

- `documents.title` / `documents.content`：GIN trigram（`pg_trgm` 扩展），支持中文模糊检索
- `documents.(owner_type, owner_id)`、`documents.created_by`：权限过滤
- `organizations.path`、`organizations.parent_id`：树查询
- `users.email` / `users.username`：唯一索引

索引在 `AppModule.onApplicationBootstrap` 中通过原始 SQL 创建（`CREATE INDEX IF NOT EXISTS`）。

## 请求流转示例

### 打开一篇 Office 文档（OnlyOffice 编辑）

```
1. 浏览器 GET /api/documents/:id           → 拿到文档元信息（format=docx/xlsx/pptx 等）
2. 浏览器 GET /api/documents/:id/onlyoffice/config?mode=edit
   ├─ OnlyOfficeService.buildConfig
   │   ├─ findOne → AccessControl.assertCanRead
   │   ├─ getOnlyOfficeDocumentType(format) → 'word' | 'cell' | 'slide'
   │   ├─ canWrite → 决定 mode=edit/view
   │   ├─ filesService.signFileToken(docId, userId)  → 短期 file token
   │   ├─ fileUrl = BACKEND_PUBLIC_URL/api/files/:id/original?token=...
   │   ├─ callbackUrl = BACKEND_PUBLIC_URL/api/documents/:id/onlyoffice/callback
   │   └─ jwtService.sign(config, onlyofficeConfig.jwtSecret) → config.token
   └─ 返回 config（含 token）
3. 浏览器注入 /onlyoffice/web-apps/.../api.js → new DocsAPI.DocEditor(el, config)
4. OnlyOffice 容器用 fileUrl 拉取原文件（带 token，绕过 session 鉴权）
5. 用户编辑保存 → OnlyOffice POST /api/documents/:id/onlyoffice/callback
   ├─ verifyCallbackToken(payload.token, jwtSecret)
   ├─ status=2/6 → 下载 payload.url 覆盖 originalPath
   ├─ 写当前 content 快照 → version+1 → content_source='onlyoffice'
   └─ refreshIndexText 异步重抽纯文本索引：
       ├─ md/txt/csv/tsv → 直接读 utf-8 入索引
       ├─ doc/docx/odt/ott/rtf/wps/wpt/ofd 等 word 类 → pandoc → plain
       └─ cell/slide/pdf → 跳过（best-effort）
6. 返回 {"error":0}
```

### 打开一篇 PDF 文档（双 tab 预览）

```
1. GET /api/documents/:id  → format=pdf
2. 默认 tab=版式预览：
   ├─ 优先：GET /api/documents/:id/kkview → 拿 kkFileView 预览 URL（iframe 嵌入）
   │   └─ 文件下载走 /api/files/:docId/original?token=（kkFileView 容器拉取）
   └─ kkFileView 未启用（503）回退：GET /api/documents/:id/pdf-html
       └─ PdfToolsService.generateLayoutHtml → pdf2htmlEX 生成 → 缓存 cache/<docId>/pdf-v<version>.html
3. 翻页预览 tab：GET /api/files/token/:docId 拿 token → pdfjs 加载 /api/files/:id/original?token=
4. 编辑文本 tab：直接编辑 documents.content（pdf-parse/docling 入库的全文）
5. 转可编辑按钮：POST /api/documents/:id/convert-to-editable
   └─ soffice PDF→docx → pandoc docx→markdown → 新建 md 文档 → 跳转
```

### 上传文档（docling 优先 + 本地回退）

```
1. POST /api/uploads  → multipart file + categoryId [+ ownerType/ownerId/isCollection]
2. UploadsService.ingest：
   ├─ 校验扩展名在白名单（allowedDocExtensions，36 项）→ 解析 DocumentFormat
   ├─ 创建 Document 行（content=null, version=1）
   ├─ 落盘 original/<docId>/<file>
   ├─ 按 format 分流解析：
   │   ├─ md/txt/csv/tsv → TextParser 直接读 utf-8（不送 docling）
   │   ├─ docx/odt/pdf 且 docling.enabled：
   │   │   ├─ 主：DoclingParser POST /v1/convert/file → markdown + 内嵌图片提取
   │   │   └─ 失败回退：PandocParser（docx/odt）/ PdfParser（pdf）
   │   └─ 不可解析格式（office 类）：content=null，仅 kkFileView 预览
   ├─ 更新 content/title/pages，docling 成功时 content_source='docling'
   └─ 写 version=1 初始快照
```

### 文档集（collection）附件聚合

```
1. POST /api/uploads/collection → 创建 is_collection=true 的主文档（无文件）
   └─ 同时把 memberDocIds 引用为 document 类型附件
2. 给集合挂 file 附件：POST /api/documents/:docId/attachments/file
3. 把另一文档加入集合：POST /api/documents/:docId/attachments/document
4. 列出附件：GET /api/documents/:docId/attachments → AttachmentsService.listByDoc
   ├─ 该文档自己的附件（file + document 类型）
   └─ 若该文档被某集合引用为成员，union 该集合主文档的 file 类型附件（集合共享附件）
5. 预览 file 附件：GET /api/documents/:docId/attachments/:attachId/kkview
   └─ 用主文档 id 签 token，kkFileView 容器拉 /api/documents/:docId/attachments/:attachId/download?token=
```

### 系统配置在线编辑

```
1. GET /api/system/config    → 返回运行时配置（LLM/OnlyOffice/kkFileView/docling/auth/upload）
2. GET /api/system/settings  → 返回可改项清单（14 项，含分组/类型/脱敏值）
3. PUT /api/system/config    → body: { items: [{ key, value }, ...] }
   └─ SystemSettingsService.updateMany：
       ├─ 白名单校验 + 类型校验（敏感项 '******' 视为不修改）
       ├─ 写 system_settings 表
       └─ setOverride 同步内存覆盖层（立即生效，config getter 优先读覆盖层）
```

## 版本与快照策略

- 每次文档更新（PUT `/api/documents/:id`）或 OnlyOffice 保存回调时：
  1. 先把当前内容写入 `document_versions`（version=当前 version，已存在则跳过）
  2. 更新 `documents` 的 content，`version + 1`
- 回滚：把目标版本内容作为新版本写入（`version + 1`），不破坏历史
- OnlyOffice 的 `document.key = "<docId>_v<version>"`，版本变化时强制重新加载

## 安全设计要点

- 静态文件不裸暴露：`/uploads/*` 无静态路由，统一走 `/api/files/:docId/*?token=`，token 绑定 docId、短期有效（附件下载同此机制，token 按主文档 id 签发）
- 路径穿越防护：`FilesService.getImageAbsPath` 规范化后校验必须落在 `images/<docId>/` 内
- 参数化查询：读权限过滤 `readableScopeFilter` 用 TypeORM Brackets + 参数化，搜索用原生 SQL 参数化，防注入
- 密码哈希：bcryptjs，`select:false` 默认查询不返回，需校验时显式 addSelect
- OnlyOffice 回调 JWT 校验：用 `ONLYOFFICE_JWT_SECRET` 校验 `payload.token`，并比对 status/key/url 防止 token 复用
- OnlyOffice 下载 URL 白名单：`downloadFile` 校验 url 主机在 `onlyofficeUrl` host + 回环白名单内，防 SSRF
- 系统配置 DTO 必须加 class-validator 装饰器：全局 ValidationPipe 启用 `forbidNonWhitelisted`，未装饰字段会被 400 拒绝
- LLM apiKey 脱敏：`/llm/my-config`、`/llm/users-overview`、`/system/config` 返回时 apiKey 已脱敏为 `******`
- 上传归属校验：group/department 归属上传时校验用户对该组织节点有写权限，防跨组织数据投毒

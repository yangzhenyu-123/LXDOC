# 前端组件

本文描述 LXDOC 前端（Vue 3 + Vite + Pinia + Element Plus）的目录结构、组件、指令、状态、路由与请求拦截。

## 目录结构

```
web/src/
├── api/                 # 接口封装（axios client + 各模块 API）
│   ├── client.ts            # axios 实例 + 拦截器（自动注入 token、401 refresh 重放）
│   ├── auth.ts              # 认证 API
│   ├── documents.ts         # 文档 API（含 OnlyOffice config、收藏、知识树、AI 总结）
│   ├── attachments.ts       # 附件 API（CRUD + kkview URL）
│   ├── files.ts             # 文件 token / 签名 URL 工具
│   ├── organizations.ts     # 组织 API
│   ├── categories.ts        # 分类 API
│   ├── uploads.ts           # 上传 API（文档/文档集/图片）
│   ├── users.ts             # 用户 API
│   ├── audit.ts             # 审计 API
│   ├── llm.ts               # LLM 配置 API（my-config / users-overview）
│   ├── system.ts            # 系统配置 API（config GET/PUT）
│   └── search.ts            # 检索 API
├── components/           # 可复用组件
│   ├── MarkdownEditor.vue   # Vditor Markdown 编辑器
│   ├── PdfViewer.vue        # pdfjs 翻页预览
│   ├── OnlyOfficeEditor.vue # OnlyOffice word/cell/slide 真编辑
│   ├── CategoryTree.vue     # 分类树（右键菜单 CRUD）
│   ├── KnowledgeTree.vue    # AI 知识树（基于 knowledge_path 渲染）
│   └── QuickAccessView.vue  # 快捷访问面板（收藏 + 最近 + 集合）
├── config/
│   └── formats.ts          # 格式常量（DOC_ACCEPT / ATTACH_ACCEPT / isOnlyOfficeEditable / getOnlyOfficeDocumentType）
├── directives/
│   └── permission.ts        # v-permission 角色指令
├── router/
│   └── index.ts             # 路由表 + 全局守卫
├── stores/
│   └── auth.ts              # Pinia 认证 store
├── styles/
│   └── tokens.css           # 设计 token（--lx-* CSS 变量，全局主题）
├── views/               # 页面
│   ├── LoginView.vue
│   ├── HomeView.vue
│   ├── CategoryView.vue
│   ├── DocumentView.vue     # 文档详情（按格式分发到不同编辑器/预览）
│   ├── SearchView.vue
│   ├── ProfileView.vue      # 个人资料（含用户级 LLM 配置）
│   ├── SystemConfigView.vue # 系统配置（admin：14 项可改配置 + 用户 LLM 概览）
│   └── admin/
│       ├── UsersView.vue
│       ├── OrganizationsView.vue
│       └── AuditView.vue
├── App.vue
├── main.ts                  # 应用入口（注册 Pinia/Router/ElementPlus/vPermission）
└── env.d.ts
```

## 入口与全局注册

`main.ts` 注册：

- `createPinia()`：状态管理
- `router`：路由
- `ElementPlus` + 全部图标组件
- `vPermission` 指令（全局 `v-permission`）

## HTTP 客户端 `api/client.ts`

全局 axios 实例，`baseURL=/api`，由 Vite proxy / nginx 转发到后端。

**请求拦截器**：从 `localStorage` 读 `lxdoc_access_token`，注入 `Authorization: Bearer`。

**响应拦截器**：

- 成功：直接返回 `response.data`（业务代码无需 `.data.data`）
- `401` 且非 `/auth/refresh`、`/auth/login`：
  1. 标记 `_retry` 防重入
  2. 用 `refreshToken` 调 `/auth/refresh`
  3. 模块级 `refreshing` Promise 防并发 refresh（多个 401 共享同一 refresh）
  4. 成功后更新 token 并重放原请求
  5. refresh 失败：清空本地态，`window.location` 跳 `/login?redirect=`

> 用 `window.location` 而非 `router.push` 跳登录，避免 `client ↔ router` 循环依赖。`refreshApi` 通过动态 `import('./auth')` 引入，规避 `client ↔ auth` 循环依赖。

## 状态管理 `stores/auth.ts`

Pinia store `useAuthStore`，负责登录态与 token 持久化。

**State**：`accessToken`、`refreshToken`、`user`

**Getters**：

| getter | 含义 |
|---|---|
| `isLoggedIn` | 是否已登录（有 accessToken） |
| `isAdmin` | 角色 === admin |
| `isEditor` | 角色 === editor |
| `canWrite` | admin 或 editor（控制上传/编辑按钮显隐） |

**Actions**：`login` / `register` / `setTokens` / `setUser` / `logout`（调后端）/ `forceLogout`（仅清本地）/ `restore`（从 localStorage 恢复）/ `refresh` / `persist` / `clear`

**localStorage 键**：`lxdoc_access_token`、`lxdoc_refresh_token`、`lxdoc_user`

## 路由 `router/index.ts`

| 路径 | 名称 | 组件 | meta |
|---|---|---|---|
| `/login` | login | LoginView | `{ public: true }` |
| `/` | home | HomeView | - |
| `/c/:categoryId` | category | CategoryView | - |
| `/d/:docId` | document | DocumentView | - |
| `/read/:docId` | read | DocsifyReaderView | - |
| `/search` | search | SearchView | - |
| `/profile` | profile | ProfileView | - |
| `/quick-access` | quick-access | QuickAccessView | - |
| `/system/config` | system-config | SystemConfigView | `{ roles: ['admin'] }` |
| `/admin/users` | admin-users | admin/UsersView | `{ roles: ['admin'] }` |
| `/admin/organizations` | admin-organizations | admin/OrganizationsView | `{ roles: ['admin'] }` |
| `/admin/audit` | admin-audit | admin/AuditView | `{ roles: ['admin'] }` |

**全局守卫** `beforeEach`：

1. `meta.public` 直接放行；已登录访问 `/login` 跳首页
2. 未登录跳 `/login?redirect=<fullPath>`
3. `meta.roles` 不匹配跳首页

路由懒加载（`() => import(...)`），按需打包。

## 指令 `directives/permission.ts`

`v-permission`：基于 `localStorage` 中的用户角色控制元素显隐。

```vue
<el-button v-permission="'admin'">仅管理员可见</el-button>
<el-button v-permission="['editor','admin']">编辑以上可见</el-button>
```

角色不在允许列表时，`mounted` 钩子直接从 DOM 移除元素。仅做前端显隐控制，**真实权限以后端为准**。

## 组件

### `MarkdownEditor.vue`

基于 [Vditor](https://github.com/Vanessa219/vditor) 的 Markdown 编辑器，用于 md / txt / PDF 全文编辑。

**Props**

| prop | 类型 | 说明 |
|---|---|---|
| `modelValue` | string | 受控内容（**不含**文件 token，存库保持干净） |
| `docId` | string | 图片上传路径 scope（可选） |
| `fileToken` | string | 渲染时拼到图片 URL 的 `?token=`（可选） |

**Events**

| event | payload | 触发时机 |
|---|---|---|
| `update:modelValue` | string（已 strip token） | 内容变化 |
| `save` | - | Ctrl/Cmd + Enter 或 Ctrl/Cmd + S |

**关键设计**

- `mode: 'ir'`（即时渲染）
- 图片上传：自定义 `upload.handler` 调 `/api/uploads/image`，光标处插入 `![](url)`
- **token 隔离**：渲染前 `rewriteImageUrls` 把 `/api/files/.../image/...` 加 `?token=`；回灌前 `stripFileTokens` 剥离 token，保证存库内容不含短期 token
- **避免光标跳动**：`watch(modelValue)` 仅在与编辑器当前值不一致时 `setValue`，用 `internalUpdate` 标记防回环
- 卸载时 `vditor.destroy()` 释放资源

### `PdfViewer.vue`

基于 [pdfjs-dist](https://github.com/mozilla/pdf.js) v4 的 PDF 翻页预览。

**Props**

| prop | 类型 | 说明 |
|---|---|---|
| `src` | string | pdf 文件签名 URL，如 `/api/files/<docId>/original?token=<token>` |

**功能**：上一页/下一页、缩放（0.5~3，步进 0.25）、下载、页码显示。

**Worker**：`pdfjsLib.GlobalWorkerOptions.workerSrc` 用 `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`，Vite 构建时单独打包 worker chunk。

### `OnlyOfficeEditor.vue`

封装 OnlyOffice Document Server 前端 SDK，用于 word/cell/slide 三类共 32 种格式的真编辑。

**Props**

| prop | 类型 | 说明 |
|---|---|---|
| `docId` | string | 文档 id |
| `mode` | 'edit' \| 'view' | 省略时后端按权限决定 |

**Events**

| event | 触发时机 |
|---|---|
| `saved` | OnlyOffice 保存回调成功后（通知父组件刷新版本） |

**流程**

1. `getOnlyOfficeConfig(docId, mode)` 拉后端 config（含 fileUrl + JWT token，后端按格式映射 documentType=word/cell/slide）
2. 动态注入 `/onlyoffice/web-apps/.../api.js`（仅一次，全局复用）
3. `new DocsAPI.DocEditor(container, config)` 初始化
4. 监听 `onSave` / `onError` / `onOutdatedVersion`（版本过期自动重建）

**降级**：api.js 加载失败或 config 接口报错时显示 `el-alert` 错误提示。

**卸载**：`editor.destroy()` + 移除注入的 `<script>`。

### `KnowledgeTree.vue`

基于 AI 总结文档的 `knowledge_path` 渲染的知识树导航组件，用于侧栏全局导航。

**Props**：无（调全局接口 `/api/documents/knowledge-tree` 拿当前用户可见的所有 AI 总结文档列表）

**功能**：

- 调 `getKnowledgeTree()` 拿 AI 总结文档列表（每条含 `knowledgePath` 字段）
- 在客户端按 `knowledgePath` 聚合成分类路径树（可折叠/展开节点）
- 点击节点跳转对应 AI 总结文档 `/read/:docId`
- 与阅读视图联动：当前文档高亮，从总结可快速跳回原文档（通过 `sourceDocId`）及相关材料

### `QuickAccessView.vue`

快捷访问面板，聚合三类入口：

- **收藏**：调 `/api/documents/favorites` 列出当前用户收藏的文档
- **最近**：调 `/api/documents/recent` 列出最近更新文档
- **集合**：列出当前用户拥有的文档集（`is_collection=true`），可展开查看集合成员

**交互**：点击文档跳 `/d/:docId`，点击集合展开/收起成员列表，点击集合成员跳转对应文档。

### `CategoryTree.vue`

基于 `el-tree` 的分类树，支持右键菜单 CRUD。

**Events**

| event | payload | 触发时机 |
|---|---|---|
| `select` | categoryId | 点击节点 |

**右键菜单**：新建子分类、重命名、删除（带确认弹窗，捕获 400 显示后端拒绝原因）。

**字段映射**：`{ label: 'name', children: 'children' }`，`default-expand-all`。

## 格式常量 `config/formats.ts`

前端共享的格式判断常量，与后端 `onlyoffice.service.ts` 同步：

| 常量 | 说明 |
|---|---|
| `DOC_ACCEPT` | 上传主文档允许的扩展名集合（36 项，逗号分隔字符串） |
| `ATTACH_ACCEPT` | 上传附件允许的扩展名集合（130+ 项） |
| `isOnlyOfficeEditable(format)` | 是否走 OnlyOffice 编辑器（word/cell/slide 32 种，排除 md/txt） |
| `getOnlyOfficeDocumentType(format)` | 返回 `'word'` / `'cell'` / `'slide'`，供 OnlyOffice config 使用 |

`DocumentView.vue` 用 `isOnlyOfficeEditable` 决定是否挂 `OnlyOfficeEditor`；`QuickAccessView.vue` 用 `DOC_ACCEPT` 校验上传文件类型；附件上传用 `ATTACH_ACCEPT`。

## 设计 token `styles/tokens.css`

全局 CSS 变量集合，命名空间 `--lx-*`，统一组件主题色/间距/圆角/字号：

```css
:root {
  --lx-color-primary: #...;
  --lx-color-primary-hover: #...;
  --lx-color-success: #...;
  --lx-color-danger: #...;
  --lx-radius-base: ...;
  --lx-spacing-base: ...;
  --lx-font-size-base: ...;
  --lx-shadow-base: ...;
  /* ... */
}
```

组件用 `var(--lx-color-primary)` 等引用，主题切换只需改 token，无需逐组件改样式。

## 文件 token 工具 `api/files.ts`

| 函数 | 作用 |
|---|---|
| `getFileToken(docId)` | 获取文件 token，内存缓存 8 分钟（后端 10 分钟，留 2 分钟余量） |
| `invalidateFileToken(docId)` | 失效缓存（文档切换时调用） |
| `buildOriginalUrl(docId, token)` | 拼原文件下载 URL |
| `rewriteImageUrls(content, token)` | 给 md/HTML 中的 `/api/files/.../image/...` 追加 `?token=` |
| `stripFileTokens(content)` | 移除文件 URL 上的 `?token=`（存库前调用） |

**为什么需要 token**：`<img src>` / pdfjs 无法带 `Authorization` 头，故用 `?token=` 短期签名 URL。token 绑定 docId、10 分钟有效，由后端 `FilesService.signFileToken` 签发。

## DocumentView 的格式分发

`DocumentView.vue` 是文档详情页，按 `doc.format` 分发到不同组件：

| format | 主区组件 | 顶部保存按钮 |
|---|---|---|
| md / txt | `MarkdownEditor` | ✅（Vditor 保存） |
| csv / tsv / word 类（doc/docx/odt/...） | `OnlyOfficeEditor`（edit/view 切换，documentType=word/cell） | ❌（OnlyOffice 自保存，仅标题/标签可改） |
| cell 类（xls/xlsx/ods/...） | `OnlyOfficeEditor`（documentType=cell） | ❌（同上） |
| slide 类（ppt/pptx/odp/...） | `OnlyOfficeEditor`（documentType=slide） | ❌（同上） |
| pdf | 双 tab：版式预览（kkFileView iframe，回退 pdf2htmlEX HTML）/ 翻页预览（`PdfViewer`） + 文本编辑 tab（`MarkdownEditor`） | ✅（编辑文本 tab） + 「转为可编辑文档」按钮 |
| 其他（不可编辑 Office / 附件型） | 仅 kkFileView 预览 | ❌ |

**版本管理**：顶部版本下拉 + 回滚按钮，`onOnlyOfficeSaved` 回调刷新版本列表与文档元信息。

**附件区**：文档详情页底部展示 `AttachmentsPanel`，按 `document_attachments` 列出附件（file + document 两类），file 类型附件可调 kkFileView 预览；文档集主文档的附件面板同时展示集合成员（document 类型附件）。

## 两级全屏状态

DocumentView 支持 `fullscreenLevel` 状态（0/1/2）：

| 级别 | 含义 | 行为 |
|---|---|---|
| 0 | 正常 | 默认布局，侧栏 + 顶栏 + 主区 |
| 1 | 专注模式 | 隐藏左侧侧栏与分类树，保留顶栏与主区，便于聚焦内容 |
| 2 | 浏览器原生全屏 | 调 `requestFullscreen()` 进入浏览器全屏，再按 Esc 退回 1 级 |

顶部「全屏」按钮循环切换 `0 → 1 → 2 → 0`， Esc 退出浏览器全屏时监听 `fullscreenchange` 自动回到 1 级。

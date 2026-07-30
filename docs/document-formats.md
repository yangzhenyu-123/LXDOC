# 文档格式处理

本文描述 md / txt / docx / odt / pdf 各格式在 LXDOC 中的上传解析、在线编辑与预览流程。

## 格式支持矩阵

| 格式 | 上传解析 | 在线编辑 | 预览 | 全文检索 |
|---|---|---|---|---|
| md | 原文入库 | Vditor 所见即所得 | Vditor 预览 | ✅ |
| txt | 原文入库 | Vditor | Vditor | ✅ |
| docx | 原文件保存 + pandoc 抽取纯文本索引 | OnlyOffice 真编辑 | OnlyOffice 查看 / pandoc HTML | ✅（索引文本） |
| odt | 同 docx | OnlyOffice 真编辑 | 同 docx | ✅ |
| pdf | 原文件保存 + pdf-parse 全文入库 | 编辑全文（Vditor） + 一键转可编辑 md | 版式预览（pdf2htmlEX） / 翻页预览（pdfjs） | ✅（全文） |

## `content_source` 字段

`documents.content_source` 标记正文来源，前端据此决定编辑器，搜索据此决定是否纳入索引：

| 值 | 含义 |
|---|---|
| `manual` | 用户手写/编辑的 md/txt |
| `pandoc` | docx 经 pandoc 抽取的**索引文本**（仅检索，不作编辑正文） |
| `pdf_text` | pdf-parse 提取的全文（可编辑 + 可检索） |
| `onlyoffice` | docx 由 OnlyOffice 回写标记 |

## 文件存储约定

```
uploads/
├── original/<docId>/<filename>     # 原始上传文件（docx/odt/pdf）
├── images/<docId>/<filename>       # docx 预览抽取的图片 / 编辑器上传的图片
└── cache/<docId>/
    ├── pdf-v<version>.html          # pdf2htmlEX 生成的版式 HTML（按版本缓存）
    └── convert/                     # PDF 转 docx/markdown 临时目录（用后清理）
```

`Document.originalPath` 存相对路径如 `original/<docId>/<file>`。

## md / txt

- **上传**：`text.parser.ts` 直接读文件内容入 `content`，`content_source='manual'`
- **编辑**：前端 `MarkdownEditor.vue`（基于 Vditor），所见即所得
- **图片**：编辑器上传图片走 `/api/uploads/image`，返回 `/api/files/:docId/image/:name`，存库前剥离 `?token=`（`stripFileTokens`）

## docx / odt（OnlyOffice 真编辑）

### 上传

1. 原文件存到 `original/<docId>/<file>`
2. `pandoc.parser.ts` 用 pandoc 抽取**纯文本**（`-t plain`）入 `content`，`content_source='pandoc'`
   - 仅用于全文检索，不再作为编辑正文（根治"导入格式乱"问题）
3. 抽取的图片存 `images/<docId>/`，HTML 预览时图片 src 改写为签名 URL

### 编辑（OnlyOffice）

前端 `DocumentView.vue` 检测 `format=docx/odt` 时挂载 `OnlyOfficeEditor.vue`：

1. 组件调 `GET /api/documents/:id/onlyoffice/config?mode=edit|view`
   - mode 由权限决定：有写权限用 `edit`，否则 `view`
2. 后端 `OnlyOfficeService.buildConfig` 返回 config：
   - `document.url` = 后端签名的短期文件下载 URL（OnlyOffice 容器拉取用）
   - `editorConfig.callbackUrl` = 后端回调地址
   - `document.key` = `<docId>#v<version>`，版本变化强制重载
   - 整个 config 用 `ONLYOFFICE_JWT_SECRET` 签名写入 `token` 字段
3. 前端动态注入 `/onlyoffice/web-apps/.../api.js`，`new DocsAPI.DocEditor(el, config)`
4. OnlyOffice 容器用 `document.url` 拉取 docx（带 token 绕过 session 鉴权）

### 保存回调

用户在 OnlyOffice 内保存时，OnlyOffice `POST /api/documents/:id/onlyoffice/callback`：

- 后端校验回调 JWT（`payload.token`）
- `status=2`（保存）或 `6`（强制保存）时：
  1. 下载 `payload.url` 的新文件，覆盖 `originalPath`
  2. 写当前 `content` 快照到 `document_versions`（version=当前）
  3. `documents.version + 1`，`content_source='onlyoffice'`
  4. 异步用 pandoc 重新抽取纯文本索引（best-effort，失败仅日志）
- 返回 `{"error":0}` 表示成功

### 原版预览（降级）

`docMode='preview'` 时调 `GET /api/documents/:id/preview`，后端用 pandoc 转 HTML 片段，图片 src 改写为签名 URL。适用于 OnlyOffice 不可用或快速查看。

## pdf

### 上传（全文入库）

`pdf.parser.ts` 用 `pdf-parse` 提取全文：

- `data.text` 完整存入 `content`（不再丢弃），`content_source='pdf_text'`
- 标题取前 100 字
- `pages` 存页数

收益：PDF 立即可全文检索；`content` 可作为基础可编辑文本。

### 三标签页预览

前端 PDF 详情页提供三个 tab：

#### 1. 版式预览（默认，pdf2htmlEX）

- `GET /api/documents/:id/pdf-html`
- 后端 `PdfToolsService.generateLayoutHtml` 调用 `pdf2htmlEX --zoom 1.3 --embed cfhj` 生成保真 HTML
- 结果按版本缓存到 `cache/<docId>/pdf-v<version>.html`，二次访问直接读缓存
- 前端 `v-html` 渲染，保留版式与字体

#### 2. 翻页预览（pdfjs）

- `PdfViewer.vue` 用 `pdfjs-dist` canvas 渲染原文件
- 文件 URL 走签名接口 `/api/files/:docId/original?token=`

#### 3. 编辑文本（Vditor）

- 直接编辑 `documents.content`（pdf-parse 入库的全文）
- 保存走 `PUT /api/documents/:id`，版本 +1

### 转为可编辑文档

顶部「转为可编辑文档」按钮（需写权限）：

- `POST /api/documents/:id/convert-to-editable`
- 后端 `PdfToolsService.convertPdfToMarkdown`：
  1. `soffice --headless --convert-to docx` PDF → docx
  2. `pandoc -f docx -t markdown` docx → markdown
- 产出的 markdown 作为**新文档**（`format=md`，`title=原标题(可编辑)`，`owner` 继承原文档）
- 原 PDF 保留不动
- 前端跳转到新文档

## 版本管理

所有格式的更新都走统一的版本快照机制：

- 每次保存 / 回滚 / OnlyOffice 回调：先写当前内容快照（version=当前），再 `version + 1`
- 回滚把目标版本内容作为新版本写入，不破坏历史
- OnlyOffice 的 `document.key` 含 version，版本变化时强制重新加载编辑器

详见 [architecture.md#版本与快照策略](./architecture.md#版本与快照策略)。

## 依赖的系统二进制

| 工具 | 用途 | Docker 安装 |
|---|---|---|
| `pandoc` | docx/odt → 纯文本索引、docx → HTML 预览、PDF 转 md 中间步骤 | Dockerfile.backend `apt install pandoc` |
| `pdf2htmlEX` | PDF → 版式保真 HTML | Debian stable 仓库不可用，需自行构建或换镜像（缺失时版式预览降级报错） |
| `soffice`（LibreOffice） | PDF → docx 转换 | Dockerfile.backend `apt install libreoffice` |
| `poppler-utils` | PDF 元信息辅助 | Dockerfile.backend `apt install poppler-utils` |
| `fonts-noto-cjk` | 中文/CJK 字体渲染 | Dockerfile.backend `apt install fonts-noto-cjk` |

详见 [deployment.md#系统二进制](./deployment.md#系统二进制依赖)。

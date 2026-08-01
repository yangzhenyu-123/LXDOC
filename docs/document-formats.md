# 文档格式处理

本文描述 LXDOC 中各文档格式的上传解析、在线编辑与预览流程。覆盖 36 种主文档格式（OnlyOffice 编辑 32 种 + pdf 只读 + md/txt 走 Vditor）与 130+ 种附件格式（kkFileView 预览）。

## 格式分类

| 类别 | 格式 | 上传解析 | 在线编辑 | 预览 | 全文检索 |
|---|---|---|---|---|---|
| 纯文本 | md / txt / csv / tsv | TextParser 直读 utf-8 入 content | md/txt 走 Vditor；csv/tsv 走 OnlyOffice cell | Vditor / OnlyOffice | ✅ |
| Office 文档类（word） | doc / docx / dot / dotm / dotx / odt / ott / rtf / wps / wpt / ofd | 原文件保存；docx/odt 优先 docling 抽取 markdown，回退 pandoc 抽 plain 入索引 | OnlyOffice word 真编辑 | OnlyOffice 查看 / kkFileView 预览 | ✅（索引文本） |
| Office 表格类（cell） | xls / xlsx / xlsm / xlt / xltm / xlam / ods / ots / fods / et / ett / csv / tsv | 原文件保存，content 为空（仅 kkFileView 预览；csv/tsv 走 TextParser 入索引） | OnlyOffice cell 真编辑 | OnlyOffice 查看 / kkFileView 预览 | csv/tsv ✅；其余仅标题 |
| Office 演示类（slide） | ppt / pptx / pptm / odp / otp / dps | 原文件保存，content 为空（仅 kkFileView 预览） | OnlyOffice slide 真编辑 | OnlyOffice 查看 / kkFileView 预览 | 仅标题 |
| 不可编辑 Office | fodt / fods / six / xla / dot（与 word 重叠的 dot 已在 word 类）等 | 原文件保存，content 为空 | ❌（走 kkFileView 预览） | kkFileView | 仅标题 |
| 版式 | pdf | 原文件保存 + docling/pdf-parse 全文入库 | 编辑全文（Vditor）+ 一键转可编辑 md | 双 tab：版式预览（kkFileView iframe，回退 pdf2htmlEX）+ 翻页预览（pdfjs） | ✅（全文） |
| 附件（不作为主文档） | 压缩包/源码/图片/Visio/CAD/3D/音视频/邮件/电子书/医疗/财务等 130+ 种 | 落盘 attachments/<docId>/，不解析 | ❌ | kkFileView 预览 | ❌ |

> OnlyOffice 三类可编辑格式共 32 种：word 13 + cell 13 + slide 6。前端 `web/src/config/formats.ts` 与后端 `onlyoffice.service.ts` 共享同一分类（前端去掉 md/txt 改走 Vditor）。

## `content_source` 字段

`documents.content_source` 标记正文来源，前端据此决定编辑器，搜索据此决定是否纳入索引：

| 值 | 含义 |
|---|---|
| `manual` | 用户手写/编辑的 md/txt，或不可解析格式占位 |
| `pandoc` | docx 经 pandoc 抽取的**索引文本**（仅检索，docx 走 OnlyOffice 编辑） |
| `pdf_text` | pdf-parse 提取的全文（docling 未启用时的回退） |
| `onlyoffice` | docx 由 OnlyOffice 回写标记 |
| `ai_summary` | AI（GLM5.2）基于原文档生成的总结文档，Docsify 风格渲染 |
| `docling` | 由 docling-serve 统一解析（支持 PDF 图片/表格/版式/OCR） |

## 文件存储约定

```
uploads/
├── original/<docId>/<filename>     # 原始上传文件（office/pdf 等）
├── images/<docId>/<filename>       # docx/docling 预览抽取的图片 / 编辑器上传的图片
├── attachments/<docId>/<filename>  # 附件文件（file 类型附件落盘）
└── cache/<docId>/
    ├── pdf-v<version>.html          # pdf2htmlEX 生成的版式 HTML（按版本缓存）
    └── convert/                     # PDF 转 docx/markdown 临时目录（用后清理）
```

`Document.originalPath` 存相对路径如 `original/<docId>/<file>`，附件 `DocumentAttachment.filePath` 存 `attachments/<docId>/<file>`。

## md / txt / csv / tsv

- **上传**：`text.parser.ts` 直接读文件内容入 `content`，`content_source='manual'`
  - csv/tsv 走 TextParser 直读 utf-8 入索引，**不送 docling**（避免 csv 被 docling 转 markdown 表格破坏原始内容）
- **编辑**：
  - md/txt：前端 `MarkdownEditor.vue`（基于 Vditor），所见即所得
  - csv/tsv：OnlyOffice cell 编辑器（表格更自然）
- **图片**：编辑器上传图片走 `/api/uploads/image`，返回 `/api/files/:docId/image/:name`，存库前剥离 `?token=`（`stripFileTokens`）

## Office 全格式（OnlyOffice 真编辑）

### 可编辑格式分类

后端 `onlyoffice.service.ts` 按格式映射 documentType：

| documentType | 格式集合 | 数量 |
|---|---|---|
| word | doc, docx, dot, dotm, dotx, odt, ott, rtf, txt, md, wps, wpt, ofd | 13 |
| cell | xls, xlsx, xlsm, xlt, xltm, xlam, ods, ots, fods, et, ett, csv, tsv | 13 |
| slide | ppt, pptx, pptm, odp, otp, dps | 6 |

> 前端 `web/src/config/formats.ts` 同步此分类，但 md/txt 优先用 MarkdownEditor（Vditor 体验更好），故 OnlyOffice 集合中已排除 md/txt。

### 上传

1. 原文件存到 `original/<docId>/<file>`
2. 可解析格式（docx/odt）：
   - docling 启用时优先走 docling，提取 markdown + 图片，`content_source='docling'`
   - 回退或未启用：pandoc 抽取**纯文本**（`-t plain`）入 `content`，`content_source='pandoc'`（仅用于全文检索）
   - 抽取的图片存 `images/<docId>/`，HTML 预览时图片 src 改写为签名 URL
3. 不可解析格式（cell/slide 中的大部分）：content 为空，仅 kkFileView 预览

### 编辑（OnlyOffice）

前端 `DocumentView.vue` 检测 `isOnlyOfficeEditable(format)` 时挂载 `OnlyOfficeEditor.vue`：

1. 组件调 `GET /api/documents/:id/onlyoffice/config?mode=edit|view`
   - mode 由权限决定：有写权限用 `edit`，否则 `view`
   - `documentType` 由后端按格式映射（word/cell/slide）
2. 后端 `OnlyOfficeService.buildConfig` 返回 config：
   - `document.url` = 后端签名的短期文件下载 URL（OnlyOffice 容器拉取用）
   - `editorConfig.callbackUrl` = 后端回调地址
   - `document.key` = `<docId>_v<version>`，版本变化强制重载
   - 整个 config 用 `ONLYOFFICE_JWT_SECRET` 签名写入 `token` 字段
3. 前端动态注入 `/onlyoffice/web-apps/.../api.js`，`new DocsAPI.DocEditor(el, config)`
4. OnlyOffice 容器用 `document.url` 拉取原文件（带 token 绕过 session 鉴权）

### 保存回调

用户在 OnlyOffice 内保存时，OnlyOffice `POST /api/documents/:id/onlyoffice/callback`：

- 后端校验回调 JWT（`payload.token`），并比对 status/key/url 防止 token 复用
- `status=2`（保存）或 `6`（强制保存）时：
  1. 下载 `payload.url` 的新文件，原子替换 `originalPath`
  2. 写当前 `content` 快照到 `document_versions`（version=当前）
  3. `documents.version + 1`，`content_source='onlyoffice'`
  4. 异步 `refreshIndexText` 重抽纯文本索引：
     - md/txt/csv/tsv → 直接读 utf-8
     - doc/docx/dot/dotm/dotx/odt/ott/rtf/wps/wpt/ofd → pandoc → plain
     - cell/slide/pdf → 跳过（best-effort，标题/标签仍可检索）
- 返回 `{"error":0}` 表示成功

### 预览（kkFileView）

`docMode='preview'` 时调 `GET /api/documents/:id/kkview`，后端拼装 kkFileView 预览 URL（文件下载走鉴权签名接口，kkFileView 容器通过 `BACKEND_PUBLIC_URL` 拉取），前端用 iframe 嵌入。kkFileView 未启用（返回 503）时回退 pandoc HTML 预览。

## pdf

### 上传解析

1. 原文件存到 `original/<docId>/<file>`
2. 优先尝试 docling（若 `docling.enabled=true`）：
   - POST `/v1/convert/file` → markdown + 内嵌图片
   - 成功则 `content` = 提取的 markdown，`content_source='docling'`，图片存 `images/<docId>/`
3. docling 未启用或失败回退到 `pdf.parser.ts`（pdf-parse）：
   - 抽取纯文本入 `content`，`content_source='pdf_text'`
4. 写入 `pages` 字段（页数）

### 双 tab 预览

PDF 文档前端默认展示两个预览 tab：

- **版式预览**（默认 tab）：
  - 优先 `GET /api/documents/:id/kkview` → kkFileView iframe 预览（高质量版式还原，含图）
  - kkFileView 未启用（503）时回退 `GET /api/documents/:id/pdf-html` → pdf2htmlEX 版式 HTML（cache/<docId>/pdf-v<version>.html）
- **翻页预览**：`GET /api/files/token/:docId` 拿 token，pdfjs 加载 `/api/files/:id/original?token=`

### 编辑

- PDF 正文可在「文本」tab 直接编辑 `content`（Vditor 编辑 docling/pdf-parse 抽出的全文）
- 顶部「转为可编辑文档」按钮（需写权限）：
  - `POST /api/documents/:id/convert-to-editable`
  - 后端 `PdfToolsService.convertPdfToMarkdown`：soffice PDF → docx → pandoc docx → markdown
  - 产出的 markdown 作为**新文档**（`format=md`，`owner` 继承原文档，`source_doc_id` 指向原 PDF）
  - 原 PDF 保留不动，前端跳转到新文档

## 附件格式（kkFileView 统一预览）

文档附件系统支持 130+ 种格式预览，覆盖主文档格式之外的各类工程/设计/媒体/存档文件。

### 附件类型

`document_attachments.attachType` 区分两类：

| attachType | 用途 | 存储位置 |
|---|---|---|
| `file` | 给主文档挂载任意格式附件文件 | `uploads/attachments/<docId>/<file>` |
| `document` | 把另一个文档引用为集合成员（不复制文件） | 引用 `linked_document_id` |

### 支持的附件格式（节选）

kkFileView 内置 LibreOffice + 各类专用解析器，可预览：

- **办公**：doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp/rtf/csv（与主文档格式重叠的部分仍可挂为附件预览）
- **压缩包**：zip/rar/7z/tar/gz/bz2（在线浏览内部文件）
- **图片**：jpg/png/gif/bmp/tiff/webp/psd/svg/heic
- **CAD/3D**：dwg/dxf/dwf；step/stp/iges/obj/stl
- **源码**：js/ts/py/go/rs/c/cpp/java/json/xml/yaml/sql/sh/md（高亮预览）
- **音视频**：mp3/mp4/mkv/avi/mov/wav/flac
- **邮件**：eml/msg
- **电子书**：epub/mobi/azw/azw3
- **财务/医疗**：ofx/qbo/dcm

完整列表见 kkFileView 5.1.0 官方支持矩阵。

### 上传与预览

```
POST /api/documents/:docId/attachments/file
  multipart: file + [description]
  → UploadsService.saveAttachment 落盘 attachments/<docId>/<file>
  → DocumentAttachment.attachType='file', filePath=...

GET /api/documents/:docId/attachments/:attachId/kkview
  → AttachmentsService.getKkviewUrl
  → 文件下载 URL = /api/documents/:docId/attachments/:attachId/download?token=（用主文档 id 签 token）
  → kkFileView 用 BACKEND_PUBLIC_URL 拉取后预览
```

### 集合成员（document 类型附件）

文档集（`is_collection=true`）的主文档可把多个文档引用为成员：

```
POST /api/documents/:docId/attachments/document
  body: { linkedDocumentId, [description] }
  → 校验权限 + 校验引用不重复
  → DocumentAttachment.attachType='document', linkedDocumentId=...
```

列出附件时（`GET /api/documents/:docId/attachments`），若该文档被某集合引用为成员，会自动 union 该集合主文档的 file 类型附件（实现「集合共享附件」）。

## 格式与前端编辑器映射

前端 `web/src/config/formats.ts` 提供共享常量：

| 常量 | 说明 |
|---|---|
| `DOC_ACCEPT` | 上传主文档允许的扩展名（36 项） |
| `ATTACH_ACCEPT` | 上传附件允许的扩展名（130+ 项） |
| `isOnlyOfficeEditable(format)` | 是否走 OnlyOffice 编辑器（word/cell/slide 32 种，排除 md/txt） |
| `getOnlyOfficeDocumentType(format)` | 返回 'word' / 'cell' / 'slide'，供 OnlyOffice config 使用 |

前端 `DocumentView.vue` 路由决策：

```
format ∈ {md, txt}                    → MarkdownEditor (Vditor)
isOnlyOfficeEditable(format) = true   → OnlyOfficeEditor
format = pdf                          → PdfView 双 tab 预览 + 文本编辑 tab
其他                                    → 仅 kkFileView 预览
```

## 版本管理

所有格式的更新都走统一的版本快照机制：

- 每次保存 / 回滚 / OnlyOffice 回调：先写当前内容快照（version=当前），再 `version + 1`
- 回滚把目标版本内容作为新版本写入，不破坏历史
- OnlyOffice 的 `document.key` 含 version，版本变化时强制重新加载编辑器

详见 [architecture.md#版本与快照策略](./architecture.md#版本与快照策略)。

## 依赖的系统二进制

| 工具 | 用途 | Docker 安装 |
|---|---|---|
| `pandoc` | docx/odt → 纯文本索引、PDF 转 md 中间步骤、Office 回调重抽索引 | Dockerfile.backend `apt install pandoc` |
| `pdf2htmlEX` | PDF → 版式保真 HTML（kkFileView 回退时使用） | Debian stable 仓库不可用，需自行构建或换镜像（缺失时回退报错） |
| `soffice`（LibreOffice） | PDF → docx 转换 | Dockerfile.backend `apt install libreoffice` |
| `poppler-utils` | PDF 元信息辅助 | Dockerfile.backend `apt install poppler-utils` |
| `fonts-noto-cjk` | 中文/CJK 字体渲染 | Dockerfile.backend `apt install fonts-noto-cjk` |

外部容器（不在 backend 容器内安装）：

| 容器 | 用途 |
|---|---|
| `onlyoffice` | Office 真编辑/查看（word/cell/slide 32 种格式） |
| `kkfileview` | 130+ 种附件格式预览 + Office/PDF 兜底预览 |
| `docling` | 文档智能解析（PDF/DOCX/ODT 图片+表格+OCR，可选 CPU sidecar） |
| `pdf2html` | pdf2htmlEX sidecar，给 kkFileView 当 PDF 预览后端 |

详见 [deployment.md#系统二进制依赖](./deployment.md#系统二进制依赖)。

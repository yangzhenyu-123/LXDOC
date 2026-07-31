# 文档解析与图片存储设计

LXDOC 上传文档后的解析、图片存储、文本入库与 AI 总结投喂的完整设计。

## 存储分层（三段式）

```
uploads/
├── original/<docId>/<docId>-<原文件名>   # 原文件（溯源/重解析/OnlyOffice 编辑）
├── images/<docId>/<图片名>               # 解析提取的图片（docx/odt/pdf）
└── cache/<docId>/                        # 转换中间产物（用后即删）
```

- `documents.content`：解析出的 Markdown 文本，图片以 `/api/files/<docId>/image/<图片名>` URL 引用
- **存库内容不含 token**：保持干净，便于版本快照与跨会话复用

## 图片引用与鉴权

content 中图片存为 `![alt](/api/files/<docId>/image/<name>)`，不带 token。渲染与编辑时由前端动态处理：

| 环节 | 机制 | 位置 |
|------|------|------|
| 存库 | `![alt](/api/files/<docId>/image/<name>)` 无 token | [docling.parser.ts](../server/src/uploads/parsers/docling.parser.ts) / [pandoc.parser.ts](../server/src/uploads/parsers/pandoc.parser.ts) |
| 前端渲染 | `rewriteImageUrls` 拼 `?token=<fileToken>` | [web/src/api/files.ts](../web/src/api/files.ts) |
| 回灌编辑器 | `stripFileTokens` 剥 token | 同上 |
| 下载校验 | `verifyFileToken`（默认 10 分钟、绑定 docId、需读权限） | [files.controller.ts](../server/src/files/files.controller.ts) |

**设计要点**：
- 图片名稳定化（`image_0001.png` / `image_0002.jpg`），重解析幂等
- 图片 scope = docId，文档转移/共享时图片跟随
- 临时图片（编辑器插入未绑定文档）scope = userId

## 解析器架构

### 双层解析：docling 为主 + 本地回退

```
                ┌─ md/txt ──────────────────────► TextParser（Node fs）
上传文件 ──► ingest ──┤
                └─ docx/odt/pdf ──► DOCLING_ENABLED?
                                      ├─ 是 ──► DoclingParser（HTTP /v1/convert/file）
                                      │            └─ 失败自动 catch 回退 ▼
                                      └─ 否 ──────────────────────────────► PandocParser / PdfParser
```

- **md/txt**：始终走 `TextParser`（纯文本，无需重型解析）
- **docx/odt/pdf**：`DOCLING_ENABLED=true` 时优先走 `DoclingParser`，失败回退 `PandocParser`（docx/odt）或 `PdfParser`（pdf）
- 回退仅记录 warn 日志，对用户透明（上传不中断）

### 各解析器能力对比

| 格式 | 本地解析器 | 能力 | docling 能力 |
|------|-----------|------|-------------|
| md/txt | TextParser | 纯文本 | 不走 docling |
| docx/odt | PandocParser | markdown + 图片（`--extract-media`），表格丢结构 | markdown + 图片 + 表格结构 |
| pdf | PdfParser（pdf-parse） | 纯文本，**无图、无版式、无表格** | markdown + 图片 + 表格 + 版式 + OCR |

docling 的核心价值：**补齐 PDF 图片/表格**，并统一 docx/odt 的表格结构还原。

## docling-serve 集成

### 调用流程

1. 后端 `DoclingParser` 读取原文件 buffer
2. `POST /v1/convert/file`（multipart），参数：
   - `image_export_mode=embedded`：图片以 data URI 内嵌进 markdown，HTTP 一次性返回（不依赖 docling 服务端文件系统）
   - `to_formats=md`
   - `do_ocr`：按 `DOCLING_DO_OCR` 配置
3. 响应 JSON 含 `document.md_content`（健壮解析，兼容数组/对象/纯文本）
4. 正则提取所有 `data:image/...;base64,...`，解码落盘到 `images/<docId>/image_NNNN.<ext>`
5. 同步替换 markdown 中 data URI 为 `/api/files/<docId>/image/<name>`

### 零依赖实现

使用 Node 20 原生 `fetch` + `FormData` + `Blob`，无需 axios/form-data。`AbortSignal.timeout` 控制超时。

## AI 总结的图片处理

LLM 无法识图，content 中的 `![](url)` 对模型是无意义噪声（浪费 token）。`summarize` 投喂前替换为占位：

```
![图1](/api/files/xxx/image/image_0001.png)  →  [图片: 图1]
```

既减少 token 又保留图片存在感知。未来如启用 docling 的 `picture_description`（需 VLM），图片自带文字描述可进一步提升总结质量。

## 配置

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `DOCLING_ENABLED` | false | 总开关，false 时全格式走本地解析器 |
| `DOCLING_URL` | http://docling:5001 | docling-serve 基地址 |
| `DOCLING_API_KEY` | （空） | docling-serve 设置 `DOCLING_SERVE_API_KEY` 时需对应 |
| `DOCLING_DO_OCR` | false | OCR 开关（扫描件/图片型 PDF），CPU 模式显著增加耗时与内存 |
| `DOCLING_TIMEOUT` | 180000 | 单次转换超时（毫秒） |

## 部署

docker-compose 已内置 docling sidecar（`docling-serve:cpu-latest`），仅 internal 网络不对外。首次启动下载约 2GB 模型（缓存在 `docling-models` volume 避免重复下载），`start_period: 120s`。资源限制 4g/2cpu。

启用：`.env` 设置 `DOCLING_ENABLED=true` 后 `docker compose up -d`。资源规划见 [部署资源规划](./resource-planning.md)。

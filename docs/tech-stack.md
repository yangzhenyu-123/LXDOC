# 开源技术栈

LXDOC 企业知识库系统使用的全部开源技术，按层次组织。

> 对应 TODO 1.1：集中开源技术清单，便于审计、合规排查、信创适配评估。

## 后端（server/）

| 技术 | 版本 | 用途 |
|------|------|------|
| NestJS | ^10.3 | 应用框架（模块化 + 依赖注入 + 装饰器路由） |
| TypeORM | ^0.3.19 | ORM（PG 实体映射 + synchronize 模式 + raw SQL 兼容 pgvector） |
| @nestjs/platform-express | ^10.3 | Express 适配（含 multipart 上传） |
| @nestjs/jwt + passport-jwt | ^10.2 / ^4.0.1 | JWT 认证（access + refresh 双 token） |
| @nestjs/passport + passport | ^10.0 / ^0.7 | Passport 鉴权框架 |
| @nestjs/throttler | ^6.5 | 限流（全局 60/min） |
| @nestjs/swagger | ^7.4 | OpenAPI 文档（生产默认关闭） |
| @nestjs/serve-static | ^4.0 | 前端静态托管（生产 nginx 反代时不用） |
| @nestjs/config | ^3.1 | 配置管理（.env + yaml 双层） |
| helmet | ^8.3 | HTTP 安全头 |
| class-validator + class-transformer | ^0.14 / ^0.5 | DTO 校验（全局 whitelist + forbidNonWhitelisted） |
| bcryptjs | ^2.4 | 密码哈希 |
| multer | ^1.4.5 | 文件上传中间件 |
| pdf-parse | ^1.1.1 | PDF 文本抽取（docling 回退路径） |
| pg | ^8.11 | PostgreSQL 驱动 |
| reflect-metadata | ^0.2 | NestJS 装饰器元数据 |

## 前端（web/）

| 技术 | 版本 | 用途 |
|------|------|------|
| Vue | ^3.4 | UI 框架（Composition API + script setup） |
| Vite | ^5.0 | 构建工具（dev server + 生产打包） |
| Vue Router | ^4.2 | SPA 路由 |
| Pinia | ^2.1 | 状态管理（auth/documents/kb store） |
| Element Plus | ^2.5 | UI 组件库 |
| @element-plus/icons-vue | ^2.3 | 图标 |
| axios | ^1.6 | HTTP 客户端（拦截器 + SSE 流式） |
| Vditor | ^3.9 | Markdown 编辑器（所见即所得 + 分屏预览） |
| marked | ^18.0 | Markdown → HTML 渲染（KB 回答/文档正文） |
| dompurify | ^3.4 | HTML 净化（防 XSS） |
| pdfjs-dist | 3.11 | PDF 翻页预览（客户端渲染） |

## 数据库与存储

| 组件 | 版本 | 用途 |
|------|------|------|
| PostgreSQL | 16 | 主数据库（文档/用户/分类/审计/KB 元数据） |
| pgvector | 0.8.2 | 向量检索扩展（kb_chunks.embedding vector(1024) + HNSW 索引） |
| pg_trgm | 1.6 | 词法检索扩展（GIN trgm 索引，RRF 融合的词法路） |

## 容器与外部服务

| 容器 | 镜像 | 用途 |
|------|------|------|
| postgres | pgvector/pgvector:pg16 | PG + pgvector + pg_trgm |
| backend | 自构（node:22-bookworm-slim） | NestJS 后端 |
| frontend | 自构（node:22-alpine → nginx:1.27-alpine） | Vue 前端 + nginx 反代 |
| onlyoffice | onlyoffice/documentserver:9.4 | 32 种 Office 格式真编辑/查看 |
| kkfileview | keking/kkfileview:5.1.0 | 130+ 种附件格式预览 + Office/PDF 兜底预览 |
| docling | quay.io/docling-project/docling-serve:cpu-latest | PDF/DOCX/ODT 智能解析（图片+表格+版式+OCR） |
| pdf2html | 自构 | pdf2htmlEX sidecar（PDF 版式 HTML，给 kkFileView 当后端） |
| tei-embed | ghcr.io/huggingface/text-embeddings-inference:cpu-1.5 | bge-m3 嵌入推理（1024 维） |
| tei-rerank | ghcr.io/huggingface/text-embeddings-inference:cpu-1.5 | bge-reranker-v2-m3 二次精排（可选，离线默认禁用） |

## AI/LLM

| 组件 | 用途 |
|------|------|
| GLM-5.2（内网，端点见 .env `LLM_BASE_URL`） | 对话生成（RAG 问答 + AI 总结 + 示例问题生成） |
| BAAI/bge-m3（1024 维） | 嵌入模型（chunk + query 向量化） |
| BAAI/bge-reranker-v2-m3 | cross-encoder 二次精排（可选） |
| Text Embeddings Inference (TEI) | HuggingFace 官方推理服务，OpenAI 兼容接口 |

## 系统二进制（backend 镜像内）

| 工具 | 用途 | 安装方式 |
|------|------|---------|
| pandoc | docx/odt → 纯文本索引、PDF 转 md 中间步骤、Office 回调重抽索引 | `apt install pandoc` |
| libreoffice (soffice) | PDF → docx 转换 | `apt install libreoffice` |
| poppler-utils | PDF 元信息辅助 | `apt install poppler-utils` |
| fonts-noto-cjk | 中文/CJK 字体渲染 | `apt install fonts-noto-cjk` |

## 解析链路

详见 [文档解析设计](./parsing.md)。各格式解析器：

| 格式 | 解析器 | 能力 |
|------|--------|------|
| md/txt/csv/tsv | TextParser | Node fs 直读 utf-8 |
| docx/odt | DoclingParser（主）/ PandocParser（回退） | markdown + 图片 + 表格（docling）/ 纯文本 + 图片（pandoc） |
| pdf | DoclingParser（主）/ PdfParser（回退） | markdown + 图片 + 表格 + 版式 + OCR（docling）/ 纯文本（pdf-parse） |
| cell/slide/其他 Office | 仅落盘 | 不解析，OnlyOffice 编辑 + kkFileView 预览 |
| 附件 130+ 种 | 仅落盘 | kkFileView 预览 |

## RAG 链路

详见 [RAG 设计](./rag.md)。

```
用户提问 → EmbeddingService（TEI bge-m3）→ RetrievalService（向量 HNSW + pg_trgm + RRF + 可选 rerank）
→ RagService（拒答阈值 + prompt 组装 + GLM 流式 + 引用 [1][2]）→ SSE → 前端打字机平滑器
```

## 版本与构建

| 工具 | 版本 | 用途 |
|------|------|------|
| Node.js | 22（生产）/ 26（开发） | 运行时 |
| pnpm | 11.6 | 包管理（allowBuilds 白名单） |
| TypeScript | ^5.3 | 类型系统 |
| ts-jest | ^29.4 | 单元测试 |
| testcontainers | ^12.0 | 集成测试（PG 容器） |
| vitest | ^2.1 | 前端单元测试 |
| Docker | 18.09+（开发）/ 25.0（生产） | 容器化 |

## 信创适配参考

当前未覆盖（需用户确认优先级）：
- 国密算法：JWT/文件 token 用 HS256，未支持 SM2/SM3/SM4
- 国产数据库：仅 PostgreSQL，未适配达梦/人大金仓/高斯
- 国产 CPU：仅 x86_64 镜像，未构建龙芯/飞腾/鲲鹏
- 国产办公集成：仅 OnlyOffice，未集成 WPS 在线编辑协议
- 桌面集成：未对接麒麟/统信 UOS 桌面端协议

# LXDOC 企业知识库 Spec

## Why
团队在研发过程中产生大量技术文档、问题解决方案与 Bug 分析报告，散落在 Word/Markdown/PDF 等异构文件中，缺少统一归档、检索与版本管理入口。需要从零构建一个轻量、可私有化部署的企业知识库 LXDOC，将多格式文档统一沉淀为可检索、可带图、可分类的知识资产。

## What Changes
- 从零搭建 LXDOC 项目骨架（Monorepo：`server/` + `web/` + `docker/`）
- 实现多格式文档入库：Markdown / TXT 直接解析；DOCX / ODT 通过 Pandoc 转 Markdown；PDF 仅做元信息提取与原文预览
- 实现知识分类树：三类顶层分类 —— 技术文档 / 解决方案 / Bug 分析报告，支持无限级子节点
- 实现 Markdown 在线编辑器（Vditor），支持图片粘贴与拖拽上传，图片落本地 `uploads/` 目录并返回 URL
- 实现文档列表、详情、全文检索（PostgreSQL `pg_trgm` + 中文分词）、标签、版本号
- 实现 PDF / DOCX / ODT 在线预览（PDF 走 pdfjs；DOCX/ODT 走 Pandoc 转 HTML 后渲染）
- 单机 Docker Compose 一键部署（app + postgres + 已安装 pandoc）

### 参考方案（已调研）
- **BookStack**：Shelf > Book > Chapter > Page 的层级结构，适合技术文档组织
- **Wiki.js**：现代化 Node.js 知识库，Markdown + WYSIWYG 双模式
- **Outline**：团队协作型，强调 Markdown 与权限
- **Mayan EDMS**：文档版本管理 + OCR + RBAC
- **WeKnora**：AI 增强知识库，pgvector 向量检索架构
- **jvs-knowledge（无忧企业文档）**：多格式在线协同 + 多级目录 + 标签 + 全文检索

## Impact
- Affected code: 全新仓库，无存量代码冲突；目录结构按 Monorepo 划分
- 外部依赖：PostgreSQL 14+、Pandoc 2.x、Node.js 20 LTS
- 部署：Docker Compose 单机起步，预留 MinIO 替换本地存储的接口

## ADDED Requirements

### Requirement: 项目骨架
系统 SHALL 提供一个 Monorepo 骨架，包含 `server/`（NestJS）、`web/`（Vue3+Vite）、`docker/`（Compose 编排）三个顶层目录，并通过 `docker compose up` 一键启动。

#### Scenario: 一键启动
- **WHEN** 开发者执行 `docker compose up -d`
- **THEN** postgres、backend、frontend 三个容器全部健康
- **AND** 浏览器访问 `http://localhost:8080` 可见知识库首页

### Requirement: 多格式文档入库
系统 SHALL 支持上传 Markdown (.md/.markdown)、TXT、DOCX、ODT、PDF 五类文件，并按格式差异化处理。

#### Scenario: Markdown/TXT 入库
- **WHEN** 用户上传 `.md` 或 `.txt` 文件
- **THEN** 系统直接读取文本作为正文，存入 `document.content`
- **AND** 文件名作为标题，可在编辑器内修改

#### Scenario: DOCX/ODT 入库
- **WHEN** 用户上传 `.docx` 或 `.odt` 文件
- **THEN** 系统调用 Pandoc 转换为 Markdown 存入正文
- **AND** 原始文件保留在 `uploads/original/`
- **AND** 内嵌图片被抽取到 `uploads/images/<docId>/` 并在 Markdown 中替换链接

#### Scenario: PDF 入库
- **WHEN** 用户上传 `.pdf` 文件
- **THEN** 系统提取页数、标题（首页文本前 100 字）作为元信息
- **AND** 正文留空，预览时直接渲染原 PDF
- **AND** 不进行 PDF→Markdown 转换（MVP 不做 OCR）

### Requirement: 分类树
系统 SHALL 提供三层顶层分类：技术文档、解决方案、Bug 分析报告，并支持任意层级子分类。

#### Scenario: 浏览分类
- **WHEN** 用户进入首页
- **THEN** 左侧显示三棵顶层分类树
- **AND** 点击节点显示该分类下所有文档（含子分类）

#### Scenario: 新建子分类
- **WHEN** 用户在某分类上"新建子分类"
- **THEN** 创建子节点并立即出现在树中
- **AND** 不允许出现同名同级分类

### Requirement: Markdown 在线编辑
系统 SHALL 提供基于 Vditor 的 Markdown 编辑器，支持图片粘贴/拖拽上传。

#### Scenario: 粘贴图片
- **WHEN** 用户在编辑器内 `Ctrl+V` 粘贴剪贴板图片
- **THEN** 图片上传到 `uploads/images/<docId>/`
- **AND** Markdown 正文插入 `![](http://localhost:8080/uploads/...)` 链接

#### Scenario: 保存版本
- **WHEN** 用户点击保存
- **THEN** 写入新版本号（自增），保留历史版本可回滚

### Requirement: 全文检索
系统 SHALL 提供中文友好的全文检索，覆盖标题、正文、标签。

#### Scenario: 关键词搜索
- **WHEN** 用户在搜索框输入关键词
- **THEN** 返回匹配文档列表，标题命中优先
- **AND** 命中片段高亮显示

### Requirement: 多格式预览
系统 SHALL 在浏览器内提供 PDF、DOCX、ODT、Markdown 的在线预览。

#### Scenario: PDF 预览
- **WHEN** 用户打开 PDF 文档详情
- **THEN** 使用 pdfjs 渲染原 PDF，支持翻页

#### Scenario: DOCX/ODT 预览
- **WHEN** 用户打开 DOCX/ODT 文档详情
- **THEN** 渲染 Pandoc 转换后的 HTML（含图片）

### Requirement: 标签与元信息
系统 SHALL 支持为文档打多个标签，并记录作者、创建时间、最后修改时间、版本号。

### Requirement: 单机 Docker 部署
系统 SHALL 提供 `docker-compose.yml`，包含 postgres、backend、frontend 三个服务，Pandoc 预装在 backend 镜像内。

## MODIFIED Requirements
（无 —— 全新项目）

## REMOVED Requirements
（无 —— 全新项目）

## 非目标（MVP 不做）
- 多用户/角色权限/审计日志（架构预留 `user_id` 字段，但不实现登录）
- AI 语义检索 / RAG 问答（预留 pgvector 扩展位）
- 协同编辑 / 实时光标
- PDF OCR 抽取正文
- 移动端原生 App

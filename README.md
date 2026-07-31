# LXDOC 企业知识库

LXDOC 是一个面向企业的知识库管理系统，支持 Markdown / TXT / DOCX / ODT / PDF 等多种文档格式的上传、解析、在线编辑与全文检索。内置「部门 / 组 / 个人」三层组织权限体系，docx 接入 OnlyOffice 原格式编辑，PDF 支持版式保真预览与一键转可编辑，并预留内网 GLM 大模型接入骨架。

## 核心特性

- **组织层级权限**：通用组织树（部门 > 组）+ 个人私有空间；每层有读权限，编辑需对应编辑授权；基于物化路径的权限继承，免递归查询。
- **文档格式处理**
  - md / txt：Vditor 所见即所得编辑 + 全文检索
  - docx / odt：OnlyOffice Document Server 真编辑，保留原格式；pandoc 抽取纯文本索引
  - pdf：全文入库（pdf-parse）+ 版式保真预览（pdf2htmlEX）+ 翻页预览（pdfjs）+ 一键转可编辑 Markdown（LibreOffice → Pandoc）
- **静态文件鉴权**：原文件 / 图片不再裸暴露，统一走 `/api/files/:docId/*?token=` 短期签名 URL，防路径穿越。
- **LLM 接入骨架**：Provider 抽象 + GLM5.2 OpenAI 兼容实现，默认关闭，待内网端点确认后一键启用；预留 RAG 向量检索扩展点。
- **认证授权**：JWT 双 token（access 15min + refresh 7d）+ RBAC（admin/editor/viewer）+ 资源级 ACL + 审计日志。
- **全文检索**：PostgreSQL `pg_trgm` + GIN trigram 索引，中文模糊匹配。

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | NestJS 10 + TypeORM + PostgreSQL 16 + JWT + Passport |
| 前端 | Vue 3 + Vite 5 + Pinia + Vue Router + Element Plus + Vditor + pdfjs-dist |
| 文档处理 | Pandoc、pdf2htmlEX、LibreOffice（soffice）、OnlyOffice Document Server |
| 部署 | Docker + Docker Compose + nginx |

## 目录结构

```
LXDOC/
├── server/              # 后端 NestJS 服务
│   └── src/
│       ├── auth/            # 认证（JWT 双 token）
│       ├── users/           # 用户管理
│       ├── organizations/   # 组织树 + 访问控制
│       ├── categories/      # 分类树
│       ├── documents/       # 文档 CRUD + 版本 + OnlyOffice + PDF 工具
│       ├── uploads/         # 上传 + 多格式解析器
│       ├── files/           # 静态文件签名鉴权
│       ├── search/          # 全文检索
│       ├── llm/             # LLM Provider 抽象 + GLM 实现
│       ├── audit/           # 审计日志
│       └── health/          # 健康检查
├── web/                 # 前端 Vue3 应用
│   └── src/
│       ├── api/             # 接口封装
│       ├── components/      # MarkdownEditor / PdfViewer / OnlyOfficeEditor / CategoryTree
│       ├── views/           # 页面（含 admin/ 管理后台）
│       └── stores/          # Pinia（auth）
├── docker/              # Dockerfile 与 nginx 配置
├── docs/                # 项目文档
├── uploads/             # 上传文件存储（.gitignore 忽略）
│   ├── original/        # 原始文件 original/<docId>/<file>
│   ├── images/          # 图片 images/<docId>/<file>
│   └── cache/           # PDF 版式 HTML 缓存 cache/<docId>/
└── docker-compose.yml   # 一键编排
```

## 文档索引

详细文档位于 [`docs/`](./docs) 目录：

| 文档 | 说明 |
|---|---|
| [docs/architecture.md](./docs/architecture.md) | 系统架构、模块划分、数据模型、请求流转 |
| [docs/permissions.md](./docs/permissions.md) | 组织树、RBAC + ACL、读写权限规则 |
| [docs/document-formats.md](./docs/document-formats.md) | md / docx / pdf 处理与编辑流程 |
| [docs/frontend.md](./docs/frontend.md) | 前端目录、组件、指令、状态、路由、HTTP 拦截 |
| [docs/database.md](./docs/database.md) | 数据库 ER 图、表结构、索引、迁移 |
| [docs/deployment.md](./docs/deployment.md) | 部署、环境变量、OnlyOffice / PDF 工具配置 |
| [docs/llm.md](./docs/llm.md) | LLM Provider 抽象、GLM5.2 接入、规划路线 |
| [docs/api-reference.md](./docs/api-reference.md) | 后端接口清单 |

## 一键启动

```bash
docker compose up -d
```

启动后：

- 前端：http://localhost:8080
- 后端 API：http://localhost:3000/api
- OnlyOffice：http://localhost:8081（经前端 nginx 反代为 `/onlyoffice`）
- PostgreSQL：localhost:5432

> 首次启动 OnlyOffice 镜像较大且需初始化字体，可能耗时 1~2 分钟。

## 首次登录

系统首次启动时会自动创建默认管理员账户，请登录后立即修改密码：

| 字段 | 值 |
|---|---|
| 邮箱 | admin@lxdoc.local |
| 密码 | lxdoc12345 |
| 角色 | admin |

登录后在右上角用户菜单点击「修改密码」即可更换。默认管理员凭据会在后端启动日志中以警告形式输出提示。

## 用户与角色

系统内置三种角色（RBAC），并与组织级 ACL 叠加：

| 角色 | 读 | 写（创建/编辑/上传） | 删除 | 用户管理 / 审计 |
|---|---|---|---|---|
| admin | ✅ 全部 | ✅ 任意资源 | ✅ 任意资源 | ✅ |
| editor | ✅ 可见范围 | ✅ 授权范围内 | ✅ 授权范围内 | ❌ |
| viewer | ✅ 可见范围 | ❌ | ❌ | ❌ |

- 所有 `/api/*` 接口（除登录/注册/health/OnlyOffice 回调）均需登录
- 自注册默认关闭，需开启时设置 `ALLOW_SIGNUP=true`
- 关键操作（登录/登出/文档与分类 CRUD/用户管理）均记录审计日志，仅 admin 可查询

详细的组织层级与权限判断规则见 [docs/permissions.md](./docs/permissions.md)。

## 端口说明

| 服务 | 端口 | 说明 |
|---|---|---|
| frontend | 8080 | 前端 Web 入口（nginx 托管 + 反代 /api、/onlyoffice） |
| backend | 3000 | 后端 NestJS API |
| onlyoffice | 8081 | OnlyOffice Document Server |
| pdf2html | 7000 | pdf2htmlEX sidecar（PDF 版式预览，仅内网） |
| docling | 5001 | docling-serve sidecar（文档解析，仅内网，可选） |
| postgres | 5432 | PostgreSQL 数据库 |

## 本地开发

### 后端

```bash
cd server
cp .env.example .env
pnpm install
pnpm dev
```

> 本地开发若需 PDF 版式预览与转可编辑，需额外安装 `pdf2htmlEX`、`libreoffice`、`pandoc`；OnlyOffice 可用本地容器 `docker run -d -p 8081:80 onlyoffice/documentserver`。

### 前端

```bash
cd web
pnpm install
pnpm dev
```

前端开发服务器（默认 5173）已配置代理：`/api` → 后端 3000，`/onlyoffice` → 本地 8081。

## 许可证

仅供内部使用。OnlyOffice Document Server 为 AGPL 许可，仅自用 / 内部部署合规；商业发行需购买商业版。

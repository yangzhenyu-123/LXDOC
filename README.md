# LXDOC 企业知识库

LXDOC 是一个面向企业的知识库管理系统，支持 Markdown / TXT / Office（doc/docx/xls/xlsx/ppt/pptx 等 36 种主文档格式）+ PDF 等多种格式的上传、解析、在线编辑与全文检索，附件系统覆盖压缩包/源码/图片/Visio/CAD/3D 模型/音视频/邮件/电子书/医疗/财务等 130+ 种 kkFileView 全格式预览。内置「部门 / 组 / 个人」三层组织权限体系，Office 全格式接入 OnlyOffice 原格式编辑，PDF 双 tab 预览（kkFileView 版式 + pdfjs 翻页），docling 智能解析（图片/表格/OCR）+ 本地回退，并内置 GLM5.2 大模型接入骨架与「AI 总结」工作流。

## 快速启动（无需克隆源码）

只需下载一个 compose 文件、填写 4 个必填密钥即可启动，全部使用预构建镜像，**不需要源码、不需要编译**。

```bash
mkdir lxdoc && cd lxdoc
curl -fsSL -o docker-compose.quickstart.yml \
  https://raw.githubusercontent.com/yangzhenyu-123/LXDOC/main/docker-compose.quickstart.yml

# 创建 .env，填写 4 个必填项（POSTGRES_PASSWORD / JWT_SECRET / ONLYOFFICE_JWT_SECRET / ADMIN_PASSWORD）
cat > .env <<'EOF'
POSTGRES_PASSWORD=改成你的强密码
JWT_SECRET=用 openssl rand -hex 32 生成
ONLYOFFICE_JWT_SECRET=用 openssl rand -hex 32 生成
ADMIN_PASSWORD=改成你的强密码
EOF

docker compose -f docker-compose.quickstart.yml up -d
```

启动后访问 http://localhost:8080，用 `admin@lxdoc.local` + `ADMIN_PASSWORD` 登录。

> 详细步骤、离线部署、运维命令见 [部署指南](./docs/deployment.md#快速开始无需克隆仓库推荐非开发者)。需完整功能（docling 文档解析 / AI 总结）改用 `docker-compose.yml`。

## 核心特性

- **组织层级权限**：通用组织树（部门 > 组）+ 个人私有空间；每层有读权限，编辑需对应编辑授权；基于物化路径的权限继承，免递归查询。
- **文档格式处理**
  - md / txt：Vditor 所见即所得编辑 + 全文检索
  - Office 全格式（doc/docx/xls/xlsx/ppt/pptx/wps/dps/et/odt/ods/odp/rtf/ofd 等 32 种）：OnlyOffice Document Server 真编辑，按 documentType 自动映射 word/cell/slide
  - pdf：双 tab 预览（版式预览优先 kkFileView iframe，回退 pdf2htmlEX；翻页预览 pdfjs）+ 一键转可编辑 Markdown（LibreOffice → Pandoc）
  - docling 智能解析：上传 docx/odt/pdf 优先走 docling-serve，提取图片/表格/版式/OCR；csv/tsv 直接 TextParser 入索引不送 docling
  - 不可解析的 Office 格式：content 为空，仅 kkFileView 预览
- **附件系统**：主文档可挂 file 类型附件（落盘 `attachments/<docId>/`）与 document 类型成员引用；附件通过 kkFileView 预览，权限继承主文档
- **文档集合**：`is_collection` 字段标记集合主文档，集合可挂多个 file 附件 + 引用其他文档作为成员（`linked_document_id`）；`listByDoc` 聚合查询自动 union 所属集合的 file 附件
- **文档收藏**：星标文档，提供「我的收藏」快捷入口
- **kkFileView 统一预览**：100+ 格式开箱即用（office/Visio/CAD/3D 模型/音视频/邮件/电子书/医疗影像/财务等），前端 iframe 嵌入
- **LLM 接入骨架**：Provider 抽象 + GLM5.2 OpenAI 兼容实现；用户级 LLM 配置（baseUrl/apiKey/model/enableThinking），admin 可设代理身份；admin 未配个人配置时回退系统配置；「AI 总结」工作流生成 Docsify 风格 Markdown 文档
- **系统配置在线编辑**：14 项可改配置（LLM 开关/端点/模型/超时、各服务开关、OCR、注册、上传大小），admin 在线修改立即生效无需重启
- **静态文件鉴权**：原文件 / 图片 / 附件不再裸暴露，统一走 `/api/files/:docId/*?token=` 短期签名 URL，防路径穿越。
- **认证授权**：JWT 双 token（access 15min + refresh 7d）+ RBAC（admin/editor/viewer）+ 资源级 ACL + 审计日志。
- **全文检索**：PostgreSQL `pg_trgm` + GIN trigram 索引，中文模糊匹配。
- **定时备份**：内置 backup 容器（cron + pg_dump + tar），自动备份 postgres 与 uploads，按天归档与过期清理。

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | NestJS 10 + TypeORM + PostgreSQL 16 + JWT + Passport |
| 前端 | Vue 3 + Vite 5 + Pinia + Vue Router + Element Plus + Vditor + pdfjs-dist |
| 文档处理 | Pandoc、pdf2htmlEX、LibreOffice（soffice）、OnlyOffice Document Server、docling-serve、kkFileView |
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
│       ├── documents/       # 文档 CRUD + 版本 + OnlyOffice + PDF 工具 + 附件 + 收藏
│       ├── uploads/         # 上传 + 多格式解析器（md/txt/csv/tsv/docx/odt/pdf）
│       ├── files/           # 静态文件签名鉴权
│       ├── search/          # 全文检索
│       ├── llm/             # LLM Provider 抽象 + GLM 实现 + 用户级 LLM 配置
│       ├── system/          # 系统配置在线编辑（system_settings）
│       ├── audit/           # 审计日志
│       └── health/          # 健康检查
├── web/                 # 前端 Vue3 应用
│   └── src/
│       ├── api/             # 接口封装（含 attachments/system/llm-config/knowledge）
│       ├── components/      # MarkdownEditor / PdfViewer / OnlyOfficeEditor / CategoryTree / KnowledgeTree
│       ├── views/           # 页面（含 admin/ 管理后台 + ProfileView + QuickAccessView）
│       ├── config/          # formats.ts（共享 OnlyOffice/上传格式常量）
│       ├── styles/          # tokens.css（设计令牌）+ global.css
│       └── stores/          # Pinia（auth）
├── docker/              # Dockerfile 与 nginx 配置（含 Dockerfile.backup / backup.sh / restore.sh）
├── docs/                # 项目文档
├── uploads/             # 上传文件存储（.gitignore 忽略）
│   ├── original/        # 原始文件 original/<docId>/<file>
│   ├── images/          # 图片 images/<docId>/<file>
│   ├── attachments/     # 附件文件 attachments/<docId>/<file>
│   └── cache/           # PDF 版式 HTML 缓存 cache/<docId>/
├── backups/             # backup 容器归档目录（.gitignore 忽略）
└── docker-compose.yml   # 一键编排（8 个服务）
```

## 文档索引

详细文档位于 [`docs/`](./docs) 目录：

| 文档 | 说明 |
|---|---|
| [docs/architecture.md](./docs/architecture.md) | 系统架构、模块划分、数据模型、请求流转 |
| [docs/permissions.md](./docs/permissions.md) | 组织树、RBAC + ACL、读写权限规则 |
| [docs/document-formats.md](./docs/document-formats.md) | 36 主文档 + 130 附件格式、OnlyOffice 三类映射、kkFileView 预览范围 |
| [docs/frontend.md](./docs/frontend.md) | 前端目录、组件、设计令牌、formats.ts 共享常量、两级全屏 |
| [docs/database.md](./docs/database.md) | 数据库 ER 图、表结构、索引、迁移 |
| [docs/deployment.md](./docs/deployment.md) | 部署、环境变量、8 服务编排、备份恢复 |
| [docs/parsing.md](./docs/parsing.md) | 文档解析与图片存储（docling 主 + 本地回退 + csv/tsv 直读） |
| [docs/llm.md](./docs/llm.md) | LLM Provider 抽象、GLM5.2 接入、用户级配置架构、AI 总结 |
| [docs/api-reference.md](./docs/api-reference.md) | 后端接口清单（含附件/收藏/系统配置/LLM 配置） |

## 一键启动（克隆仓库后）

已克隆仓库的用户可直接用完整编排（含 docling/AI 总结等可选功能）：

```bash
cp .env.example .env
# 编辑 .env：必须设置 POSTGRES_PASSWORD / JWT_SECRET / ONLYOFFICE_JWT_SECRET / ADMIN_PASSWORD
docker compose up -d
```

启动后：

- 前端：http://localhost:8080
- 后端 API：http://localhost:3000/api（仅内网，经前端 nginx 反代）
- OnlyOffice：仅内网（容器端口 80，经前端 nginx 反代为 `/onlyoffice`）
- kkFileView：仅内网（经前端 nginx 反代为 `/kkview`）
- PostgreSQL：仅内网（不对外暴露端口）

> 首次启动 OnlyOffice 镜像较大且需初始化字体，可能耗时 1~2 分钟。非开发者建议用上文「快速启动」方式，无需克隆源码。

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

完整编排（`docker-compose.yml`）共 8 个服务：

| 服务 | 端口 | 对外 | 说明 |
|---|---|---|---|
| frontend | 8080 | ✅ | 前端 Web 入口（nginx 托管 + 反代 /api、/onlyoffice、/kkview） |
| backend | 3000 | ❌ | 后端 NestJS API（仅内网，经 nginx 反代） |
| onlyoffice | 80 | ❌ | OnlyOffice Document Server 9.4（经 nginx 反代为 /onlyoffice） |
| kkfileview | 8012 | ❌ | kkFileView 5.1.0 统一预览（经 nginx 反代为 /kkview） |
| pdf2html | 7000 | ❌ | pdf2htmlEX sidecar（kkFileView 不可用时回退，仅内网） |
| docling | 5001 | ❌ | docling-serve sidecar（文档智能解析，仅内网，可选） |
| backup | - | ❌ | 定时备份容器（cron + pg_dump + tar） |
| postgres | 5432 | ❌ | PostgreSQL 16 数据库（仅内网） |

> 仅 `8080` 对外暴露，其余服务均在内部网络，最小攻击面。

## 本地开发

### 后端

```bash
cd server
cp .env.example .env
pnpm install
pnpm dev
```

> 本地开发若需 PDF 版式预览与转可编辑，需额外安装 `pdf2htmlEX`、`libreoffice`、`pandoc`；OnlyOffice 可用本地容器 `docker run -d -p 8082:80 onlyoffice/documentserver`。kkFileView / docling / backup 等可选服务可单独 `docker compose -f docker-compose.dev.yml up -d <服务名>` 启动。

### 前端

```bash
cd web
pnpm install
pnpm dev
```

前端开发服务器（默认 5173）已配置代理：`/api` → 后端 3000，`/onlyoffice` → 本地 8082（dev compose 映射 8082:80）。

## 许可证

仅供内部使用。OnlyOffice Document Server 为 AGPL 许可，仅自用 / 内部部署合规；商业发行需购买商业版。

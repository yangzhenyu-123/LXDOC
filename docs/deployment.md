# 部署指南

本文描述 LXDOC 的部署方式、环境变量、OnlyOffice / PDF 工具配置与常见问题。

## 快速开始（无需克隆仓库，推荐非开发者）

只需下载一个 compose 文件、填写 4 个必填项即可启动，全部使用 GHCR 预构建镜像，**不需要源码、不需要编译**。

### 前置要求

- Docker 20.10+ 与 Docker Compose v2（`docker compose` 命令）
- 服务器：**4 核 / 8 GB / 50 GB SSD** 起步（详见 [部署资源规划](./resource-planning.md)）
- 端口 8080 可用（对外访问入口）
- 可访问 `ghcr.io` 拉取镜像（内网无外网时需先手动导入镜像，见下文「离线部署」）

### 步骤 1：下载编排文件

只需一个文件，无需克隆整个仓库：

```bash
mkdir lxdoc && cd lxdoc
# 下载快速启动编排文件（仓库 raw 地址，也可手动下载后放入该目录）
curl -fsSL -o docker-compose.quickstart.yml \
  https://raw.githubusercontent.com/yangzhenyu-123/LXDOC/main/docker-compose.quickstart.yml
```

> 若服务器无法访问 GitHub，可在任意能联网的机器上下载该文件，再拷贝到服务器。文件内容见仓库根目录 `docker-compose.quickstart.yml`。

### 步骤 2：创建 .env 并填写必填项

在 compose 文件同目录创建 `.env` 文件，**必须**填写以下 4 个值（不填或留默认值，后端启动会直接拒绝）：

```bash
cat > .env <<'EOF'
# ===== 以下 4 项必填，未设置后端拒绝启动 =====
# 数据库密码（自定义强密码）
POSTGRES_PASSWORD=请改成你的强密码
# JWT 签名密钥（生成：openssl rand -hex 32）
JWT_SECRET=请用 openssl rand -hex 32 生成
# OnlyOffice JWT 密钥（生成：openssl rand -hex 32）
ONLYOFFICE_JWT_SECRET=请用 openssl rand -hex 32 生成
# 初始管理员密码（首次启动 seed 用，之后可登录修改）
ADMIN_PASSWORD=请改成你的强密码

# ===== 以下可选，按需修改 =====
# 管理员邮箱（默认 admin@lxdoc.local）
ADMIN_EMAIL=admin@lxdoc.local
# 是否开放自注册（默认 false，仅管理员可创建用户）
ALLOW_SIGNUP=false
# 镜像版本（默认 latest，固定版本如 v0.2.0）
# LXDOC_IMAGE_TAG=v0.2.0
EOF
```

> 三个密钥务必用 `openssl rand -hex 32` 生成强随机值，不要使用示例文本。

### 步骤 3：启动

```bash
docker compose -f docker-compose.quickstart.yml up -d
```

首次启动会拉取镜像（约 4-5 GB）并初始化 OnlyOffice 字体，约 3-5 分钟。查看启动进度：

```bash
docker compose -f docker-compose.quickstart.yml logs -f backend
```

看到 `LXDOC 后端服务已启动` 即可访问。

### 步骤 4：访问与登录

- 地址：http://localhost:8080（如部署在远程服务器，把 localhost 换成服务器 IP）
- 登录：邮箱 `admin@lxdoc.local`（或你在 `.env` 中设置的 `ADMIN_EMAIL`），密码为 `ADMIN_PASSWORD` 的值
- **登录后请立即在右上角用户菜单修改密码**

### 常用运维命令

```bash
# 查看所有服务状态
docker compose -f docker-compose.quickstart.yml ps

# 查看某服务日志（-f 实时跟踪）
docker compose -f docker-compose.quickstart.yml logs -f backend

# 停止（保留数据）
docker compose -f docker-compose.quickstart.yml down

# 启动
docker compose -f docker-compose.quickstart.yml up -d

# 升级版本（修改 .env 中 LXDOC_IMAGE_TAG 后）
docker compose -f docker-compose.quickstart.yml pull
docker compose -f docker-compose.quickstart.yml up -d

# 备份数据库
docker exec lxdoc-postgres pg_dump -U lxdoc lxdoc > backup-$(date +%F).sql

# 备份上传文件（原文件 + 图片）
tar czf uploads-$(date +%F).tar.gz uploads/
```

### 快速启动包含的服务

| 服务 | 端口 | 说明 |
|---|---|---|
| `frontend` | 8080 | nginx 托管前端 + 反代 `/api`、`/onlyoffice`、`/kkview` |
| `backend` | 3000 | NestJS API（不对外，经 nginx 反代） |
| `onlyoffice` | 8081 | OnlyOffice Document Server 9.4（不对外，经 nginx 反代） |
| `kkfileview` | 8012 | kkFileView 统一预览（不对外，经 nginx 反代） |
| `pdf2html` | 7000 | pdf2htmlEX sidecar（仅内网，kkFileView 不可用时的回退） |
| `postgres` | 5432 | PostgreSQL 16（仅内网） |

> 仅 `8080` 对外暴露，其余服务均在内部网络，最小攻击面。

### 快速启动不包含的功能

快速启动编排追求最小可用，以下功能需改用完整编排（见下文「从源码部署」）：

- **docling 文档解析**（PDF 图片/表格/OCR）：默认关闭，上传回退本地 pdf-parse。需要时改用完整 `docker-compose.yml` 并设 `DOCLING_ENABLED=true`
- **AI 总结**：默认关闭。需要时在 `.env` 配置 `LLM_ENABLED=true` + `LLM_BASE_URL` 指向内网 GLM 端点
- **API 调试文档**：默认关闭。需要时在 `.env` 设 `ENABLE_API_DOCS=true`

### 离线部署（内网无外网）

1. 在能联网的机器拉取镜像并导出：
   ```bash
   docker pull ghcr.io/yangzhenyu-123/lxdoc-backend:latest
   docker pull ghcr.io/yangzhenyu-123/lxdoc-frontend:latest
   docker pull ghcr.io/yangzhenyu-123/lxdoc-pdf2html:latest
   docker pull onlyoffice/documentserver:9.4
   docker pull keking/kkfileview:4.4.0
   docker pull postgres:16-alpine
   docker save -o lxdoc-images.tar \
     ghcr.io/yangzhenyu-123/lxdoc-backend:latest \
     ghcr.io/yangzhenyu-123/lxdoc-frontend:latest \
     ghcr.io/yangzhenyu-123/lxdoc-pdf2html:latest \
     onlyoffice/documentserver:9.4 \
     keking/kkfileview:4.4.0 \
     postgres:16-alpine
   ```
2. 将 `lxdoc-images.tar`、`docker-compose.quickstart.yml` 拷贝到内网服务器
3. 内网服务器导入镜像：`docker load -i lxdoc-images.tar`
4. 后续步骤同上（创建 `.env`、`docker compose ... up -d`）

---

## 从源码部署（开发者 / 需完整功能）

适合需要本地构建、启用 docling、或定制 Dockerfile 的场景。

```bash
git clone <repo> LXDOC && cd LXDOC
cp .env.example .env
# 编辑 .env：必须设置 POSTGRES_PASSWORD / JWT_SECRET / ONLYOFFICE_JWT_SECRET / ADMIN_PASSWORD
docker compose up -d
```

> **构建模式**：默认拉取 GHCR 预构建镜像（开箱即用）。如需本地构建（开发/自定义 Dockerfile），用 `docker compose up -d --build`。指定版本：`.env` 中设 `LXDOC_IMAGE_TAG=v1.0.0`。

启动的服务：

| 服务 | 端口 | 说明 |
|---|---|---|
| `frontend` | 8080 | nginx 托管前端 + 反代 `/api`、`/onlyoffice`、`/kkview` |
| `backend` | 3000 | NestJS API |
| `onlyoffice` | 8081 | OnlyOffice Document Server 9.4 |
| `kkfileview` | 8012 | kkFileView 统一预览（100+ 格式，仅内网） |
| `pdf2html` | 7000 | pdf2htmlEX sidecar（PDF 版式预览回退，仅内网） |
| `docling` | 5001 | docling-serve sidecar（统一文档解析，仅内网，可选） |
| `postgres` | 5432 | PostgreSQL 16 |

启动后访问 http://localhost:8080，默认管理员 `admin@lxdoc.local` / `lxdoc12345`（开发环境；生产需在 `.env` 设置 `ADMIN_PASSWORD`）。

> OnlyOffice 镜像较大且首次需初始化字体，可能耗时 1~2 分钟。可用 `docker logs -f lxdoc-onlyoffice` 观察就绪状态。

### 直接拉取镜像

CI 自动构建的镜像托管在 GHCR（公开），可直接拉取：

```bash
docker pull ghcr.io/yangzhenyu-123/lxdoc-backend:latest
docker pull ghcr.io/yangzhenyu-123/lxdoc-frontend:latest
docker pull ghcr.io/yangzhenyu-123/lxdoc-pdf2html:latest
# 指定版本：ghcr.io/yangzhenyu-123/lxdoc-backend:v1.0.0
```

镜像版本列表见 [GHCR Packages](https://github.com/yangzhenyu-123?tab=packages)。onlyoffice / postgres / docling 使用官方镜像，无需自行拉取。

## CI 自动发布

仓库通过 GitHub Actions 自动构建并发布 Docker 镜像到 GHCR（[`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml)）。

**触发方式**：推送 `v*` 格式的 tag（如 `v1.0.0`、`v1.0.0-rc1`）自动构建 backend / frontend / pdf2html 三个镜像，打 `<tag>` 与 `latest` 标签。也可在 Actions 页面手动触发（`workflow_dispatch`，仅打 `<tag>` 不覆盖 `latest`）。

**发布流程**：
```bash
# 1. 确认改动已合并到 main 且本地 build 通过
# 2. 打 tag
git tag v1.0.0
git push origin v1.0.0
# 3. Actions 自动构建并推 GHCR，完成后镜像可 docker pull
```

**镜像命名**：`ghcr.io/yangzhenyu-123/lxdoc-<name>:<tag>`（name = backend / frontend / pdf2html）

**自定义镜像源**：在 `.env` 设置 `LXDOC_IMAGE_PREFIX` 覆盖默认前缀（如内网镜像源 `registry.internal/your-org`，拼接后为 `registry.internal/your-org/lxdoc-backend`）。

> 仅构建 `linux/amd64`：pdf2html 的 AppImage 仅为 amd64，arm64 需自行从源码构建（见 [PDF 版式预览](#pdf-版式预览pdf2htmlex-sidecar)）。

## API 调试文档（Swagger UI）

后端内置交互式 API 调试文档，部署后可直接在浏览器调试全部接口：

- 调试入口：`http://localhost:8080/api/docs`（compose 部署经 nginx 反代）
- 鉴权：点击右上角 `Authorize`，填入 `Bearer <accessToken>`（先调 `POST /api/auth/login` 获取）
- 上传接口（`POST /api/uploads`、`POST /api/uploads/image`）支持文件选择框直接上传调试
- OpenAPI JSON `/api/docs-json`、YAML `/api/docs-yaml` 可导入 Postman / Apifox

**启用开关** `ENABLE_API_DOCS`：
- 开发环境（`NODE_ENV !== production`）默认开启
- 生产环境（compose 部署 `NODE_ENV=production`）**默认关闭**，避免接口结构对外泄露；需调试时在 `.env` 设置 `ENABLE_API_DOCS=true` 后 `docker compose up -d` 重启

完整接口清单见 [API 参考](./api-reference.md)。

## 文档解析（docling-serve）

LXDOC 上传文档采用「docling 为主 + 本地回退」双层解析，支持带图片文档的存储：

- `DOCLING_ENABLED=true` 时，docx/odt/pdf 优先走 docling-serve sidecar，提取图片到 `images/<docId>/`，content 以 `/api/files/<docId>/image/<name>` 引用
- docling 不可用时自动回退 pandoc/pdf-parse，上传不中断
- PDF 经 docling 解析可提取图片/表格/版式（本地 pdf-parse 只能取纯文本）

启用方式：`.env` 设置 `DOCLING_ENABLED=true`（默认关闭）。扫描件需额外设 `DOCLING_DO_OCR=true`（CPU 模式吃内存，sidecar 需 4g+）。

存储设计与解析流程详见 [文档解析与图片存储设计](./parsing.md)，资源影响见 [部署资源规划](./resource-planning.md)。

## 服务编排说明

`docker-compose.yml` 关键配置：

### backend

- 环境变量注入 OnlyOffice / PDF 工具 / LLM 配置（见下表）
- `./uploads:/app/uploads` 挂载上传目录到宿主机持久化
- 健康检查探活 `/health`

### onlyoffice

- 镜像 `onlyoffice/documentserver:9.4`（9.4 起移除 RabbitMQ/Postgres 依赖，单进程架构，社区版无 20 连接限制；AGPL 许可，仅自用/内部部署合规）
- `JWT_ENABLED=true` + `JWT_SECRET` 与后端 `ONLYOFFICE_JWT_SECRET` 共享
- 持久化卷：`onlyoffice-data`（文档转换缓存与字体）、`onlyoffice-cache`
- 端口 8081:80，前端经 nginx 反代为同源 `/onlyoffice`

### kkfileview

- 镜像 `keking/kkfileview:4.4.0`（开源预览中间件，内置 LibreOffice，支持 100+ 格式）
- 作为 docx/odt/pdf 等保真预览的统一入口，替代 pandoc/pdf2htmlEX 预览降级链路
- 端口 8012，前端经 nginx 反代为同源 `/kkview`
- 软依赖：未就绪时预览接口返回 503，前端自动回退 pdf2htmlEX

### frontend（nginx）

`docker/nginx.conf` 反代规则：

- `/` → 前端静态资源（SPA 回退 index.html）
- `/api/` → `backend:3000`
- `/onlyoffice/` → `onlyoffice:80`（WebSocket + 长超时 + 100m body）
- `/kkview/` → `kkfileview:8012`（预览 iframe，长超时 + 100m body）

> 注意：nginx **不**直接暴露 `/uploads/` 目录。所有原始文件 / 图片访问统一走鉴权接口 `/api/files/...`（基于 JWT 签名 token），直接映射磁盘会导致越权下载。

## 环境变量

完整配置见 [`server/.env.example`](../server/.env.example)。

### 基础

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 后端端口 |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASS` / `DB_NAME` | postgres / 5432 / lxdoc / lxdoc / lxdoc | PostgreSQL 连接 |
| `UPLOAD_DIR` | /app/uploads | 上传文件根目录 |
| `NODE_ENV` | production | 运行环境 |

### 认证

| 变量 | 默认 | 说明 |
|---|---|---|
| `JWT_SECRET` | lxdoc-dev-secret-change-me | JWT 签名密钥，**生产务必更换** |
| `JWT_ACCESS_EXPIRES` | 15m | access token 有效期 |
| `JWT_REFRESH_EXPIRES` | 7d | refresh token 有效期 |
| `ALLOW_SIGNUP` | false | 是否开放自注册 |
| `FILE_TOKEN_EXPIRES` | 10m | 静态文件签名 token 有效期 |

### OnlyOffice

| 变量 | 默认 | 说明 |
|---|---|---|
| `ONLYOFFICE_ENABLED` | true | 是否启用 OnlyOffice（false 时前端走 pandoc 预览降级） |
| `ONLYOFFICE_URL` | http://onlyoffice | OnlyOffice 容器内部地址（后端拼 fileUrl 用，需容器可达） |
| `ONLYOFFICE_PUBLIC_URL` | /onlyoffice | 浏览器可访问地址（前端 api.js 加载来源，通常同源反代） |
| `BACKEND_PUBLIC_URL` | http://backend:3000 | OnlyOffice 回调后端的地址（需 OnlyOffice 容器可达后端） |
| `ONLYOFFICE_JWT_SECRET` | lxdoc-onlyoffice-dev-secret | 与 OnlyOffice 容器 `JWT_SECRET` 共享，签发 config 与校验回调 |

> 三个地址语义：`ONLYOFFICE_URL` 是后端→OnlyOffice，`BACKEND_PUBLIC_URL` 是 OnlyOffice→后端（kkFileView 拉取文件也复用此地址），`ONLYOFFICE_PUBLIC_URL` 是浏览器→OnlyOffice。生产部署若网络隔离需分别配置。

### kkFileView 预览

| 变量 | 默认 | 说明 |
|---|---|---|
| `KKFILEVIEW_ENABLED` | true | 是否启用 kkFileView 统一预览（false 时前端回退 pandoc/pdf2htmlEX） |
| `KKFILEVIEW_URL` | http://kkfileview:8012 | kkFileView 容器内部地址（后端拼接预览 URL 用） |
| `KKFILEVIEW_PUBLIC_URL` | /kkview | 浏览器可访问地址（前端 iframe 加载来源，通常同源反代） |

> 预览流程：后端 `GET /api/documents/:id/kkview` 返回拼接好的 kkFileView 预览 URL（文件下载走鉴权签名接口 `/api/files/:docId/original?token=`，kkFileView 容器通过 `BACKEND_PUBLIC_URL` 拉取）。前端用 iframe 嵌入该 URL。kkFileView 未启用（返回 503）时前端自动回退 pdf2htmlEX。

### PDF 工具

| 变量 | 默认 | 说明 |
|---|---|---|
| `PDF2HTML_URL` | http://pdf2html:7000 | pdf2htmlEX sidecar HTTP 地址；为空则降级为本地 `PDF2HTML_BIN` 二进制 |
| `PDF2HTML_BIN` | pdf2htmlEX | 本地 pdf2htmlEX 二进制路径（仅 `PDF2HTML_URL` 为空时使用，开发降级） |
| `SOFFICE_BIN` | soffice | LibreOffice soffice 路径（PDF→docx，后端镜像内本地执行） |

### LLM

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_ENABLED` | false | 是否启用 LLM（false 时 chat/embed 返回 null，业务降级） |
| `LLM_BASE_URL` | http://internal-glm/v1 | 内网 GLM OpenAI 兼容端点 |
| `LLM_API_KEY` | （空） | 调用密钥，内网无需鉴权可留空 |
| `LLM_MODEL` | glm-5.2 | 默认对话模型 |
| `LLM_EMBED_MODEL` | （空） | 向量模型，留空则 RAG 向量检索禁用 |
| `LLM_EMBED_DIMENSIONS` | 0 | 向量维度，与 pgvector 列对齐 |
| `LLM_TIMEOUT` | 30000 | 单次请求超时（毫秒） |
| `LLM_MAX_RETRIES` | 2 | 最大重试次数（指数退避） |

### 前端

| 变量 | 默认 | 说明 |
|---|---|---|
| `VITE_ONLYOFFICE_URL` | /onlyoffice | 浏览器加载 OnlyOffice api.js 的基础地址 |

## 系统二进制依赖

后端镜像 `docker/Dockerfile.backend` 基于 `node:20-bookworm-slim`，已安装：

```
pandoc libreoffice poppler-utils fonts-noto-cjk
```

- `pandoc` / `libreoffice`（soffice）：PDF 转可编辑（PDF→docx→markdown），在后端镜像内本地执行
- `poppler-utils`：PDF 元信息辅助

### PDF 版式预览（pdf2htmlEX sidecar）

`pdf2htmlEX` 在 Debian stable 仓库不可用，故作为独立 sidecar 服务 `docker/pdf2html`，**docker-compose 已内置**，开箱即用：

- 镜像基于 `debian:bookworm-slim`，下载 pdf2htmlEX 官方 AppImage（v0.18.8.rc1，固定版本），构建时预解压（`--appimage-extract`）到 `/opt/pdf2htmlex`，运行时直接调 `AppRun`（无需 FUSE）
- HTTP 服务仅依赖 Python 标准库（`server.py`），监听 7000：`POST /convert`（请求体为原始 PDF 字节，返回版式保真 HTML）、`GET /health`
- 仅 compose 内网暴露，不对外发布，故无需鉴权 token
- 后端 `PdfToolsService` 通过 `PDF2HTML_URL` 以 HTTP 调用，结果按 `docId#version` 缓存到 `uploads/cache/<docId>/`

**降级**：若 `PDF2HTML_URL` 为空（如本地开发），后端回退到本地 `PDF2HTML_BIN` 二进制（需本机安装 pdf2htmlEX）。sidecar 故障时仅影响 PDF「版式预览」tab，「翻页预览」「编辑文本」「转可编辑」不受影响。

**自建 sidecar**：如内网无法直连 GitHub 下载 AppImage，可用 `--build-arg PDF2HTML_APPIMAGE_URL=<内网地址>` 覆盖下载源，或自行构建 sidecar 镜像后通过 `PDF2HTML_URL` 指向。

> 注：该 AppImage 仅为 x86_64。arm64 部署需自行从源码构建 pdf2htmlEX。

## 本地开发（完整功能测试）

开发者本地跑后端 + 前端热重载，依赖服务（postgres / onlyoffice / pdf2html / docling）用 `docker-compose.dev.yml` 一键启动，即可测试全部功能。

### 前置依赖

- Node.js 20+、pnpm 9+
- Docker + Docker Compose v2
- 系统二进制：`pandoc`（PDF 转可编辑 + docx/odt 回退解析需要）
  - macOS：`brew install pandoc`
  - Linux：`apt install pandoc`
  - Windows：建议 WSL2，`apt install pandoc`
- 可选：`libreoffice`（PDF 转可编辑的 soffice，macOS 装 LibreOffice.app，Linux `apt install libreoffice`）
  - 未装时 PDF「转可编辑」功能不可用，其余功能不受影响

### 步骤 1：启动依赖服务

```bash
docker compose -f docker-compose.dev.yml up -d
```

启动的服务（端口均映射到宿主机，方便本地直连）：

| 服务 | 宿主机端口 | 用途 |
|------|-----------|------|
| postgres | 5432 | 数据库（用户/密码/db 均为 `lxdoc`） |
| onlyoffice | 8081 | docx/odt 编辑 |
| kkfileview | 8012 | 统一预览（docx/odt/pdf 保真预览） |
| pdf2html | 7000 | PDF 版式预览（kkFileView 不可用时回退） |
| docling | 5001 | 文档解析（可选，不测可 `stop docling`） |

> docling 首次启动下载模型约 2GB，耗时较长；不测文档解析可先 `docker compose -f docker-compose.dev.yml stop docling`。

### 步骤 2：配置后端 .env

```bash
cd server
cp .env.example .env
```

编辑 `server/.env`，关键调整（本地开发默认值已可用，仅需改以下几项适配本地网络）：

```bash
# 数据库指向本地映射的 postgres
DB_HOST=localhost
DB_PORT=5432
DB_USER=lxdoc
DB_PASS=lxdoc
DB_NAME=lxdoc

# OnlyOffice 回调本地后端：容器内通过 host.docker.internal 访问宿主机
BACKEND_PUBLIC_URL=http://host.docker.internal:3000
# OnlyOffice 容器地址（本地直连映射端口）
ONLYOFFICE_URL=http://localhost:8081

# kkFileView 统一预览：本地直连映射端口（浏览器与后端均用 localhost:8012）
KKFILEVIEW_ENABLED=true
KKFILEVIEW_URL=http://localhost:8012
KKFILEVIEW_PUBLIC_URL=http://localhost:8012

# PDF 版式预览：指向本地映射的 pdf2html（kkFileView 不可用时回退）
PDF2HTML_URL=http://localhost:7000

# 文档解析：启用 docling（不测可保持 false）
DOCLING_ENABLED=true
DOCLING_URL=http://localhost:5001

# AI 总结：有内网 GLM 端点时开启（无则保持 false，总结接口会返回 503）
# LLM_ENABLED=true
# LLM_BASE_URL=http://your-glm-endpoint/v1
```

> 本地开发 `NODE_ENV` 未设置（非 production），故 `JWT_SECRET` / `ONLYOFFICE_JWT_SECRET` 可用默认值，后端不会强校验；`ADMIN_PASSWORD` 也无需设置，会用默认 `lxdoc12345`。

### 步骤 3：启动后端

```bash
cd server
pnpm install
pnpm dev          # 监听 3000，热重载
```

- TypeORM `synchronize=true`（开发模式自动建表，改 entity 即生效）
- `pg_trgm` 扩展与 GIN 索引在 `onApplicationBootstrap` 自动创建
- API 调试文档默认开启：http://localhost:3000/api/docs
- 看到日志 `LXDOC 后端服务已启动` 即就绪

### 步骤 4：启动前端

```bash
cd web
pnpm install
pnpm dev          # 监听 5173，热重载
```

`vite.config.ts` 已配置代理：

- `/api` → `http://localhost:3000`（后端）
- `/onlyoffice` → `http://localhost:8081`（OnlyOffice，可用 `VITE_ONLYOFFICE_PROXY` 覆盖）

访问 http://localhost:5173，用 `admin@lxdoc.local` / `lxdoc12345` 登录。

### 完整功能测试清单

各功能依赖的服务与验证方式：

| 功能 | 依赖服务 | 验证方式 |
|------|---------|---------|
| 登录 / 用户管理 | postgres | 登录成功，admin 页面可建用户 |
| 上传 md/txt | postgres | 上传后内容可编辑、可搜索 |
| 上传 docx/odt | postgres + pandoc | 上传后图片显示、pandoc 预览正常 |
| docx/odt 编辑 | onlyoffice | 打开文档进入 OnlyOffice 编辑器，保存后版本+1 |
| docx/odt/pdf 统一预览 | kkfileview | 文档「版式预览」tab 显示 kkFileView iframe 保真预览 |
| PDF 全文入库 | postgres | 上传 PDF 后内容可搜索 |
| PDF 版式预览 | kkfileview（回退 pdf2html） | PDF 文档「版式预览」tab 显示保真预览（kkFileView 不可用时回退 pdf2htmlEX） |
| PDF 翻页预览 | 后端（pdfjs） | PDF 文档「翻页预览」tab 正常翻页 |
| PDF 转可编辑 | soffice + pandoc | 点「转可编辑」生成新 md 文档（需本机装 libreoffice） |
| 文档解析（图片/表格） | docling | `DOCLING_ENABLED=true` 时上传 PDF，content 含 `![](/api/files/...)` 图片引用 |
| AI 总结 | LLM 端点 | `LLM_ENABLED=true` 时点「AI 总结」生成新文档（无 LLM 端点返回 503 属正常） |
| 全文检索 | postgres | 搜索框输入关键词返回结果，snippet 高亮 |
| 组织权限 | postgres | 建部门/组，分配成员，验证读写隔离 |
| 审计日志 | postgres | 登录/文档操作后，admin 审计页可查 |
| API 调试 | 后端 | http://localhost:3000/api/docs 在线调接口 |

### 常见问题

**OnlyOffice 编辑器加载失败 / 白屏**
- 确认 `docker compose -f docker-compose.dev.yml ps onlyoffice` 状态为 running
- 浏览器 F12 看 `/onlyoffice/web-apps/...` 是否 200（vite 代理 8081）
- 后端 `.env` 的 `BACKEND_PUBLIC_URL=http://host.docker.internal:3000`（OnlyOffice 容器回调本地后端）
- 验证容器能否回调后端：`docker exec lxdoc-dev-onlyoffice curl -I http://host.docker.internal:3000/health`

**kkFileView 预览白屏 / 加载失败**
- 确认 kkfileview 健康：`docker compose -f docker-compose.dev.yml ps kkfileview`
- 浏览器 F12 看 `/kkview/onlinePreview` 请求是否 200
- kkFileView 容器需能拉取文件：`BACKEND_PUBLIC_URL` 必须容器可达（本地开发为 `http://host.docker.internal:3000`）
- 验证容器能否拉取文件：`docker exec lxdoc-dev-kkfileview curl -I http://host.docker.internal:3000/health`
- kkFileView 不可用时前端自动回退 pdf2htmlEX，不影响翻页预览/编辑

**PDF 版式预览报错**
- 确认 pdf2html 健康：`docker compose -f docker-compose.dev.yml ps pdf2html`
- 后端 `.env` 的 `PDF2HTML_URL=http://localhost:7000`
- 验证后端可访问：浏览器访问 http://localhost:7000/health 返回 200

**docling 解析未生效（上传 PDF 无图片）**
- 确认 `DOCLING_ENABLED=true` 且 docling 容器健康（首次启动需下载模型，约 2GB）
- `DOCLING_URL=http://localhost:5001`
- 后端日志应有 `docling 提取图片 N 张`；若回退会 warn `docling 解析失败，回退到本地解析器`

**前端 5173 访问后端 404**
- 确认后端 `pnpm dev` 在 3000 运行
- vite 代理 `/api` → 3000，无需额外配置

**端口冲突**
- 5432/8081/8012/7000/5001/3000/5173 被占用时改 `docker-compose.dev.yml` 的端口映射或停掉占用进程

### 仅测后端 API（不需要前端）

后端 `pnpm dev` 启动后，直接用 Swagger UI 调试全部接口，无需启动前端：

```
http://localhost:3000/api/docs
```

点击右上角 Authorize，填 `Bearer <accessToken>`（先调 `POST /api/auth/login`，用 `admin@lxdoc.local` / `lxdoc12345` 登录获取）。

### 数据库直连

本地映射了 5432，可用任意客户端连接：

```
host: localhost
port: 5432
user: lxdoc
password: lxdoc
database: lxdoc
```

重置开发数据：`docker compose -f docker-compose.dev.yml down -v`（删除 volume 后重启即全新库）。

## 生产部署建议

1. **更换密钥**：`JWT_SECRET`、`ONLYOFFICE_JWT_SECRET` 改为强随机值
2. **关闭自注册**：`ALLOW_SIGNUP=false`
3. **HTTPS**：在 nginx 前加 TLS 终止（或用 traefik/caddy）
4. **备份**：定期备份 PostgreSQL（`pg_dump`）与 `uploads/` 目录
5. **资源**：OnlyOffice 较吃内存，建议 ≥ 4G；可限制并发编辑数
6. **网络隔离**：`BACKEND_PUBLIC_URL` 与 `ONLYOFFICE_URL` 在容器间内网通信，不暴露公网
7. **关闭 synchronize**：生产环境 `synchronize=false`，用 migration 管理 schema
8. **资源规划**：硬件选型、磁盘预估与运维补充配置见 [部署资源规划](./resource-planning.md)

## 常见问题

### OnlyOffice 打开文档白屏 / 加载失败

- 检查 `ONLYOFFICE_URL` 后端→OnlyOffice 容器是否通：`docker exec lxdoc-backend curl -I http://onlyoffice`
- 检查 `BACKEND_PUBLIC_URL` OnlyOffice→后端是否通：`docker exec lxdoc-onlyoffice curl -I http://backend:3000/health`
- 检查 `ONLYOFFICE_JWT_SECRET` 与 onlyoffice 容器 `JWT_SECRET` 是否一致
- 查 OnlyOffice 日志：`docker logs -f lxdoc-onlyoffice`

### kkFileView 预览白屏 / 加载失败

docker-compose 部署下统一预览由 `kkfileview` 服务提供，开箱即用。若报错排查：

- 服务是否健康：`docker compose ps kkfileview`、`docker logs lxdoc-kkfileview`
- 后端 `KKFILEVIEW_ENABLED=true` 且 `KKFILEVIEW_URL` 正确指向 `http://kkfileview:8012`
- kkFileView 容器能否拉取文件：`docker exec lxdoc-kkfileview curl -I http://backend:3000/health`（依赖 `BACKEND_PUBLIC_URL`）
- 浏览器 F12 看 `/kkview/onlinePreview` 请求是否 200
- kkFileView 不可用时前端自动回退 pdf2htmlEX，不影响翻页预览/编辑

### PDF 版式预览报错

docker-compose 部署下版式预览由 `pdf2html` sidecar 提供（kkFileView 不可用时的回退）。若报错排查：

- sidecar 是否健康：`docker compose ps pdf2html`、`docker logs lxdoc-pdf2html`
- 后端能否访问 sidecar：`docker exec lxdoc-backend node -e "fetch('http://pdf2html:7000/health').then(r=>console.log(r.status))"`
- 后端 `PDF2HTML_URL` 是否正确指向 `http://pdf2html:7000`
- 本地开发（非 compose）需将 `PDF2HTML_URL` 留空并安装本地 pdf2htmlEX，或单独 `docker compose up pdf2html` 后指向 `http://localhost:7000`

详见上文 [PDF 版式预览](#pdf-版式预览pdf2htmlex-sidecar)。

### 图片加载 401 / token 过期

- 文件 token 默认 10 分钟过期，前端缓存 8 分钟刷新
- 长时间停留页面后图片失效，刷新页面重新获取 token
- 编辑器回灌内容前会 `stripFileTokens` 清掉 token，存库内容不含短期 token

### 中文显示方块

- 后端镜像已装 `fonts-noto-cjk`；若自行构建镜像请确保安装中文字体
- OnlyOffice 容器自带常用字体，如缺可挂载字体目录

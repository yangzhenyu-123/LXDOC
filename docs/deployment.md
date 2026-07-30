# 部署指南

本文描述 LXDOC 的部署方式、环境变量、OnlyOffice / PDF 工具配置与常见问题。

## 一键部署（Docker Compose）

```bash
git clone <repo> LXDOC && cd LXDOC
cp .env.example .env
# 编辑 .env：必须设置 POSTGRES_PASSWORD / JWT_SECRET / ONLYOFFICE_JWT_SECRET
docker compose up -d
```

> **构建模式**：默认拉取 GHCR 预构建镜像（开箱即用）。如需本地构建（开发/自定义 Dockerfile），用 `docker compose up -d --build`。指定版本：`.env` 中设 `LXDOC_IMAGE_TAG=v1.0.0`。

启动的服务：

| 服务 | 端口 | 说明 |
|---|---|---|
| `frontend` | 8080 | nginx 托管前端 + 反代 `/api`、`/onlyoffice` |
| `backend` | 3000 | NestJS API |
| `onlyoffice` | 8081 | OnlyOffice Document Server |
| `pdf2html` | 7000 | pdf2htmlEX sidecar（PDF 版式预览，仅内网） |
| `postgres` | 5432 | PostgreSQL 16 |

启动后访问 http://localhost:8080，默认管理员 `admin@lxdoc.local` / `lxdoc12345`。

> OnlyOffice 镜像较大且首次需初始化字体，可能耗时 1~2 分钟。可用 `docker logs -f lxdoc-onlyoffice` 观察就绪状态。

### 直接拉取镜像（无需克隆仓库）

CI 自动构建的镜像托管在 GHCR（公开），可直接拉取：

```bash
docker pull ghcr.io/yangzhenyu-123/lxdoc-backend:latest
docker pull ghcr.io/yangzhenyu-123/lxdoc-frontend:latest
docker pull ghcr.io/yangzhenyu-123/lxdoc-pdf2html:latest
# 指定版本：ghcr.io/yangzhenyu-123/lxdoc-backend:v1.0.0
```

镜像版本列表见 [GHCR Packages](https://github.com/yangzhenyu-123?tab=packages)。onlyoffice / postgres 使用官方镜像，无需自行拉取。

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

**自定义镜像源**：在 `.env` 设置 `LXDOC_IMAGE_PREFIX` 覆盖默认前缀（如内网镜像源 `registry.internal/lxdoc`）。

> 仅构建 `linux/amd64`：pdf2html 的 AppImage 仅为 amd64，arm64 需自行从源码构建（见 [PDF 版式预览](#pdf-版式预览pdf2htmlex-sidecar)）。

## 服务编排说明

`docker-compose.yml` 关键配置：

### backend

- 环境变量注入 OnlyOffice / PDF 工具 / LLM 配置（见下表）
- `./uploads:/app/uploads` 挂载上传目录到宿主机持久化
- 健康检查探活 `/health`

### onlyoffice

- 镜像 `onlyoffice/documentserver:latest`（AGPL 许可，仅自用/内部部署合规）
- `JWT_ENABLED=true` + `JWT_SECRET` 与后端 `ONLYOFFICE_JWT_SECRET` 共享
- 持久化卷：`onlyoffice-data`（文档转换缓存与字体）、`onlyoffice-cache`
- 端口 8081:80，前端经 nginx 反代为同源 `/onlyoffice`

### frontend（nginx）

`docker/nginx.conf` 反代规则：

- `/` → 前端静态资源（SPA 回退 index.html）
- `/api/` → `backend:3000`
- `/onlyoffice/` → `onlyoffice:80`（WebSocket + 长超时 + 100m body）

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

> 三个地址语义：`ONLYOFFICE_URL` 是后端→OnlyOffice，`BACKEND_PUBLIC_URL` 是 OnlyOffice→后端，`ONLYOFFICE_PUBLIC_URL` 是浏览器→OnlyOffice。生产部署若网络隔离需分别配置。

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

## 本地开发

### 后端

```bash
cd server
cp .env.example .env
pnpm install
pnpm dev          # 监听 3000，热重载
```

本地需安装 `pandoc`（macOS `brew install pandoc`，Linux `apt install pandoc`）。PDF 版式预览可选：本地开发将 `.env` 中 `PDF2HTML_URL` 留空，并安装本地 `pdf2htmlEX` 二进制（设 `PDF2HTML_BIN`），否则该 tab 会报工具不可用。OnlyOffice 可用容器：

```bash
docker run -d --name onlyoffice -p 8081:80 \
  -e JWT_ENABLED=true -e JWT_SECRET=lxdoc-onlyoffice-dev-secret \
  onlyoffice/documentserver
```

### 前端

```bash
cd web
pnpm install
pnpm dev          # 监听 5173
```

`vite.config.ts` 已配置代理：

- `/api` → `http://localhost:3000`
- `/onlyoffice` → `http://localhost:8081`（可用 `VITE_ONLYOFFICE_PROXY` 覆盖）

### 数据库

本地可用容器跑 PostgreSQL：

```bash
docker run -d --name lxdoc-pg -p 5432:5432 \
  -e POSTGRES_USER=lxdoc -e POSTGRES_PASSWORD=lxdoc -e POSTGRES_DB=lxdoc \
  postgres:16-alpine
```

TypeORM `synchronize=true`（开发模式自动建表），生产应改用 migration。`pg_trgm` 扩展与 GIN 索引在 `AppModule.onApplicationBootstrap` 中自动创建。

## 生产部署建议

1. **更换密钥**：`JWT_SECRET`、`ONLYOFFICE_JWT_SECRET` 改为强随机值
2. **关闭自注册**：`ALLOW_SIGNUP=false`
3. **HTTPS**：在 nginx 前加 TLS 终止（或用 traefik/caddy）
4. **备份**：定期备份 PostgreSQL（`pg_dump`）与 `uploads/` 目录
5. **资源**：OnlyOffice 较吃内存，建议 ≥ 4G；可限制并发编辑数
6. **网络隔离**：`BACKEND_PUBLIC_URL` 与 `ONLYOFFICE_URL` 在容器间内网通信，不暴露公网
7. **关闭 synchronize**：生产环境 `synchronize=false`，用 migration 管理 schema

## 常见问题

### OnlyOffice 打开文档白屏 / 加载失败

- 检查 `ONLYOFFICE_URL` 后端→OnlyOffice 容器是否通：`docker exec lxdoc-backend curl -I http://onlyoffice`
- 检查 `BACKEND_PUBLIC_URL` OnlyOffice→后端是否通：`docker exec lxdoc-onlyoffice curl -I http://backend:3000/health`
- 检查 `ONLYOFFICE_JWT_SECRET` 与 onlyoffice 容器 `JWT_SECRET` 是否一致
- 查 OnlyOffice 日志：`docker logs -f lxdoc-onlyoffice`

### PDF 版式预览报错

docker-compose 部署下版式预览由 `pdf2html` sidecar 提供，开箱即用。若报错排查：

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

# 部署指南

本文描述 LXDOC 的部署方式、环境变量、OnlyOffice / PDF 工具配置与常见问题。

## 一键部署（Docker Compose）

```bash
git clone <repo> LXDOC && cd LXDOC
docker compose up -d
```

启动的服务：

| 服务 | 端口 | 说明 |
|---|---|---|
| `frontend` | 8080 | nginx 托管前端 + 反代 `/api`、`/onlyoffice` |
| `backend` | 3000 | NestJS API |
| `onlyoffice` | 8081 | OnlyOffice Document Server |
| `postgres` | 5432 | PostgreSQL 16 |

启动后访问 http://localhost:8080，默认管理员 `admin@lxdoc.local` / `lxdoc12345`。

> OnlyOffice 镜像较大且首次需初始化字体，可能耗时 1~2 分钟。可用 `docker logs -f lxdoc-onlyoffice` 观察就绪状态。

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
- `/uploads/` → `backend:3000`（兼容旧链接）
- `/onlyoffice/` → `onlyoffice:80`（WebSocket + 长超时 + 100m body）

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
| `PDF2HTML_BIN` | pdf2htmlEX | pdf2htmlEX 路径（缺失时版式预览降级报错） |
| `SOFFICE_BIN` | soffice | LibreOffice soffice 路径 |

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

### pdf2htmlEX 特别说明

`pdf2htmlEX` 在 Debian stable 仓库**不可用**（仅 sid/unstable），Dockerfile 默认未安装。影响：

- PDF「版式预览」tab 不可用，会显示错误提示
- 「翻页预览」「编辑文本」「转可编辑」不受影响

启用方案（任选其一）：

1. **自行构建衍生镜像**：在 Dockerfile.backend 中加装 pdf2htmlEX（参考 [pdf2htmlEX 官方构建](https://github.com/pdf2htmlEX/pdf2htmlEX)）
2. **换用第三方镜像**：基于已含 pdf2htmlEX 的基础镜像
3. **单独服务**：用独立的 pdf2htmlEX 容器，后端通过 HTTP 调用

## 本地开发

### 后端

```bash
cd server
cp .env.example .env
pnpm install
pnpm dev          # 监听 3000，热重载
```

本地需安装 `pandoc`（macOS `brew install pandoc`，Linux `apt install pandoc`）。OnlyOffice 可用容器：

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

### PDF 版式预览报错「pdf2htmlEX 未安装」

见上文 [pdf2htmlEX 特别说明](#pdf2htmlex-特别说明)。

### 图片加载 401 / token 过期

- 文件 token 默认 10 分钟过期，前端缓存 8 分钟刷新
- 长时间停留页面后图片失效，刷新页面重新获取 token
- 编辑器回灌内容前会 `stripFileTokens` 清掉 token，存库内容不含短期 token

### 中文显示方块

- 后端镜像已装 `fonts-noto-cjk`；若自行构建镜像请确保安装中文字体
- OnlyOffice 容器自带常用字体，如缺可挂载字体目录

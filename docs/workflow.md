# 本地开发 + 远程部署调试工作流

本文档总结 LXDOC 项目在开发机本地编码、同步到生产机部署、远程调试的完整工作流。
适用于「代码在开发机、生产机无外网、需离线部署 RAG 全栈」的场景。

> **环境前提**
> - 开发机：有外网，可拉镜像、装依赖、构建镜像
> - 生产机：无外网（HuggingFace/GitHub/ghcr.io 全部不可达），仅内网 GLM 端点可达
> - 生产机无外网 → 镜像在开发机构建后 `docker save` → `scp` → `docker load` 传入

> **⚠️ 安全说明**
> 本文档所有 `<PLACEHOLDER>` 占位符对应的真实值（主机 IP / 密码 / API key / JWT secret）
> 一律由开发者在本地 `.env` / `server/.env` / shell 环境变量中维护，**不入库、不写入文档**。
> 推荐用 SSH key 替代 `sshpass` 密码登录；如必须用密码，通过 `sshpass -e` 读环境变量 `SSHPASS`，
> 避免密码出现在命令行历史与进程列表。

---

## 1. 环境信息

### 开发机

| 项目 | 值 |
|------|-----|
| 项目根目录 | `<DEV_WORKDIR>`（开发机自定） |
| 系统 | openEuler 22.03 LTS-SP4 |
| Docker | 18.09.0（API 最大版本 1.39） |
| Node | v26.1.0 |
| pnpm | 11.6.0 |
| 注意 | 所有 docker/docker-compose 命令前须加 `DOCKER_API_VERSION=1.39`；`docker compose` v2 不可用，用 `docker-compose` v1 |

### 生产机

| 项目 | 值 |
|------|-----|
| 地址 | `<PROD_HOST>`（在 shell 环境变量或 `.env` 维护） |
| 登录 | 推荐 `ssh root@<PROD_HOST>`（SSH key 免密）；临时密码方式见下文 |
| 项目目录 | `<PROD_WORKDIR>`（生产机自定，如 `/home/lxdoc`） |
| 系统 | openEuler 24.03 |
| Docker | 25.0.3 / docker-compose v5.1.1 |
| 资源 | 384 核 / 1TB RAM / 4.5T 磁盘 |
| 外网 | 不可达（DNS 解析失败） |
| 内网 GLM | 端点见 `.env` 的 `LLM_BASE_URL`（host 与 `LLM_ENDPOINT_HOST` 一致，IP 见 `LLM_ENDPOINT_IP`） |

### 内网 GLM 端点

```
URL:   见 .env 的 LLM_BASE_URL（host 与 LLM_ENDPOINT_HOST 一致）
Key:   见 .env 的 LLM_API_KEY
Model: 见 .env 的 LLM_MODEL（默认 zai-org/GLM-5.2-FP8）
```

> **容器内 DNS 陷阱**：宿主机 `/etc/hosts` 中的静态解析不会注入 Docker 容器，容器内 LLM 端点 host 会 `EAI_AGAIN`。
> 已在 `docker-compose.yml` backend 段通过 `extra_hosts` 注入（host 与 IP 由 `.env` 的 `LLM_ENDPOINT_HOST` / `LLM_ENDPOINT_IP` 提供），见 §4。

### SSH 访问推荐姿势

```bash
# 1. 一次性配置 SSH key（推荐）
ssh-copy-id root@<PROD_HOST>
# 之后 ssh / rsync / scp 均免密

# 2. 临时密码方式（不写入命令行历史）
export SSHPASS='<PROD_SSH_PASS>'   # 仅当前 shell 会话有效
sshpass -e ssh -o StrictHostKeyChecking=accept-new root@<PROD_HOST> 'echo ok'
# rsync/scp 同样用 sshpass -e
```

> 下方示例统一用 `ssh root@<PROD_HOST>`（假设已配 SSH key）；如用密码方式，自行在每个 ssh/rsync/scp 前加 `sshpass -e`。

---

## 2. 代码同步（开发机 → 生产机）

### 2.1 rsync 同步源码与配置

```bash
cd <DEV_WORKDIR>
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude '.env' \
  --exclude '参考项目' --exclude 'backups' --exclude 'uploads' \
  -e 'ssh -o StrictHostKeyChecking=accept-new' \
  ./ root@<PROD_HOST>:<PROD_WORKDIR>/
```

**排除项说明**：
- `.git`：版本历史不入生产
- `node_modules`/`dist`：生产用容器内构建，不入
- `.env`：生产机有独立 `.env`（含生产密码），绝不能覆盖
- `参考项目`：8 个参考项目目录（CowAgent/MimirQ 等），不入
- `backups`/`uploads`：运行时数据，不入

### 2.2 同步后修正权限

```bash
ssh root@<PROD_HOST> '
  chown -R root:root <PROD_WORKDIR>
  git config --global --add safe.directory <PROD_WORKDIR>
'
```

### 2.3 生产机 .env 配置

生产机 `<PROD_WORKDIR>/.env` 包含所有生产配置，**rsync 不会覆盖**（已排除）。
关键变量见 `.env.example`，生产环境须设置：

```env
# 多 compose 文件叠加
COMPOSE_FILE=docker-compose.yml:docker-compose.rag.yml

# 数据库（生产强密码，用 openssl rand -hex 32 生成）
POSTGRES_PASSWORD=<POSTGRES_PASSWORD>

# 认证（生产强随机值，用 openssl rand -hex 32 生成）
JWT_SECRET=<JWT_SECRET>
ONLYOFFICE_JWT_SECRET=<ONLYOFFICE_JWT_SECRET>
ADMIN_EMAIL=admin@lxdoc.local
ADMIN_PASSWORD=<ADMIN_PASSWORD>

# LLM（内网 GLM；host 与下方 LLM_ENDPOINT_HOST 一致）
LLM_ENABLED=true
LLM_BASE_URL=http://<LLM_HOST>/v1
LLM_API_KEY=<LLM_API_KEY>
LLM_MODEL=zai-org/GLM-5.2-FP8

# Embedding（TEI 容器内通信；用 overlay 时为 compose 服务名）
LLM_EMBED_BASE_URL=http://tei-embed:80
LLM_EMBED_MODEL=BAAI/bge-m3
LLM_EMBED_DIMENSIONS=1024

# Rerank（离线无模型则留空，backend 自动跳过回退纯 RRF）
LLM_RERANK_BASE_URL=
LLM_RERANK_MODEL=BAAI/bge-reranker-v2-m3
LLM_RERANK_CANDIDATE_K=20

# GLM 端点 DNS 注入（注入容器 extra_hosts）
# LLM_ENDPOINT_HOST 须与 LLM_BASE_URL 的 host 一致
LLM_ENDPOINT_HOST=<LLM_HOST>
LLM_ENDPOINT_IP=<LLM_ENDPOINT_IP>
```

---

## 3. 镜像构建与传输

生产机无外网，镜像须在开发机构建后导入。

### 3.1 构建镜像

```bash
cd <DEV_WORKDIR>

# backend 镜像（Node 22 + pnpm 11.6）
DOCKER_API_VERSION=1.39 docker build \
  -f docker/Dockerfile.backend \
  -t ghcr.io/yangzhenyu-123/lxdoc-backend:latest \
  server/

# frontend 镜像
DOCKER_API_VERSION=1.39 docker build \
  -f docker/Dockerfile.frontend \
  -t ghcr.io/yangzhenyu-123/lxdoc-frontend:latest \
  .
```

> **注意磁盘**：`docker save` 输出不要存 `/tmp`（tmpfs 仅 7.6G），存工作区或 `/home`（root 分区 240G+ 可用）。

### 3.2 导出 + 传输 + 加载

```bash
# 导出（存到工作区，不要存 /tmp）
DOCKER_API_VERSION=1.39 docker save ghcr.io/yangzhenyu-123/lxdoc-backend:latest \
  -o /tmp/opencode/lxdoc-backend.tar

# scp 到生产
scp -o StrictHostKeyChecking=accept-new \
  /tmp/opencode/lxdoc-backend.tar root@<PROD_HOST>:/tmp/

# 生产机加载 + 清理
ssh root@<PROD_HOST> '
  docker load -i /tmp/lxdoc-backend.tar
  rm -f /tmp/lxdoc-backend.tar
'

# 开发机清理
rm -f /tmp/opencode/lxdoc-backend.tar
```

### 3.3 镜像版本管理

```bash
# 查看生产机镜像
ssh root@<PROD_HOST> \
  'docker images ghcr.io/yangzhenyu-123/* --format "{{.Repository}}:{{.Tag}} {{.CreatedSince}} {{.Size}}"'

# 查看镜像内文件（验证构建完整性）
ssh root@<PROD_HOST> \
  'docker run --rm --entrypoint="" ghcr.io/yangzhenyu-123/lxdoc-backend:latest ls /app/dist/knowledge-base/'
```

---

## 4. 启动与重启服务

### 4.1 全栈启动

```bash
ssh root@<PROD_HOST> '
  cd <PROD_WORKDIR>
  docker-compose up -d
  docker-compose ps
'
```

### 4.2 单服务重启

```bash
# 只重启 backend（如更新了镜像）
ssh root@<PROD_HOST> '
  cd <PROD_WORKDIR> && docker-compose up -d backend
'

# 只重启 TEI embed（如调整了内存限制）
ssh root@<PROD_HOST> '
  cd <PROD_WORKDIR> && docker-compose up -d tei-embed
'
```

### 4.3 容器状态检查

```bash
ssh root@<PROD_HOST> '
  cd <PROD_WORKDIR>
  docker-compose ps
  echo "---"
  docker stats --no-stream --format "{{.Name}}: MEM {{.MemUsage}} CPU {{.CPUPerc}}"
'
```

> **extra_hosts 注入说明**：`docker-compose.yml` backend 段已加：
> ```yaml
> extra_hosts:
>   - "${LLM_ENDPOINT_HOST:-llm-endpoint}:${LLM_ENDPOINT_IP:-127.0.0.1}"
> ```
> `.env` 中设 `LLM_ENDPOINT_HOST=<LLM_HOST>` + `LLM_ENDPOINT_IP=<LLM_ENDPOINT_IP>`，
> `LLM_ENDPOINT_HOST` 须与 `LLM_BASE_URL` 的 host 一致，否则容器内 fetch LLM_BASE_URL 仍会 DNS 失败。

---

## 5. RAG 全链路验证

### 5.1 登录获取 Token

```bash
TOKEN=$(ssh root@<PROD_HOST> '
  curl -s -X POST http://localhost:8080/api/auth/login \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"admin@lxdoc.local\",\"password\":\"'"$ADMIN_PASSWORD"'\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)[\"accessToken\"])"
')
echo "$TOKEN"
```

> `$ADMIN_PASSWORD` 由本地 shell `export ADMIN_PASSWORD=...` 提供，避免硬编码。

### 5.2 知识库 CRUD

```bash
# 创建知识库
ssh root@<PROD_HOST> "
  curl -s -X POST http://localhost:8080/api/knowledge-bases \
    -H 'Authorization: Bearer $TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"name\":\"测试库\",\"description\":\"验证用\"}'
"

# 列表
ssh root@<PROD_HOST> \
  "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost:8080/api/knowledge-bases"
```

### 5.3 检索测试

```bash
KB_ID=<上一步返回的 id>
ssh root@<PROD_HOST> \
  "curl -s -H 'Authorization: Bearer $TOKEN' \
   'http://localhost:8080/api/knowledge-bases/$KB_ID/retrieve?query=测试&topK=5'"
```

### 5.4 RAG 问答（流式）

```bash
ssh root@<PROD_HOST> "
  curl -s -N -X POST http://localhost:8080/api/knowledge-bases/$KB_ID/ask \
    -H 'Authorization: Bearer $TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"query\":\"LXDOC是什么？\"}'
"
```

预期 SSE 事件序列：
1. `references` — 检索命中的 chunk 列表（含 score、hitBy）
2. `reasoning` / `delta` — GLM 流式推理/回答 token
3. `done` — 最终 answer（含引用标记 `[1]`）、messageId、confidence（none/low/medium/high）

### 5.5 反馈（P9）

```bash
# 点赞 rating=1 / 点踩 rating=-1（点踩须带 reason）
ssh root@<PROD_HOST> "
  curl -s -X POST http://localhost:8080/api/knowledge-bases/feedback \
    -H 'Authorization: Bearer $TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"messageId\":\"<上一步 done 事件的 messageId>\",\"kbId\":\"$KB_ID\",\"rating\":1}'
"
```

### 5.6 拒答阈值

| 模式 | 单路命中阈值 | 双路命中阈值 | 说明 |
|------|-------------|-------------|------|
| RRF（无 rerank） | 0.020 | 0.030 | RRF score = 1/(60+rank)，单路最高 1/61≈0.0164，双路 2/61≈0.0328 |
| rerank | 0.05 | 0.15 | rerank 模式 score 0~1，阈值更高 |

低于阈值时返回 `isFallback: true, confidence: "none"`，不调用 GLM。

---

## 6. 常见问题排查

### 6.1 TEI embed 容器重启循环（OOM）

**现象**：`docker logs lxdoc-tei-embed` 显示加载 `model.onnx` 后容器退出，`dmesg` 有 `oom-kill`。

**原因**：多核机器（384 核）TEI 自动起 192 个 tokenization worker，每个持有模型副本，峰值 RSS 33GB，超过 `mem_limit`。

**修复**（已合入 `docker-compose.rag.yml`）：
```yaml
command: --model-id BAAI/bge-m3 --max-batch-tokens 8192 \
         --max-concurrent-requests 64 --tokenization-workers 16
mem_limit: 32g
```

**验证**：
```bash
ssh root@<PROD_HOST> '
  docker inspect lxdoc-tei-embed --format "RestartCount: {{.RestartCount}}"
  docker logs lxdoc-tei-embed 2>&1 | grep "Ready"
'
```

### 6.2 backend 报错 "需通过 ADMIN_PASSWORD 设置管理员密码"

**原因**：`docker-compose.yml` backend 段未透传 `ADMIN_PASSWORD` 环境变量。

**修复**（已合入）：backend `environment` 段加：
```yaml
ADMIN_EMAIL: ${ADMIN_EMAIL:-admin@lxdoc.local}
ADMIN_PASSWORD: ${ADMIN_PASSWORD:?必须在 .env 中设置 ADMIN_PASSWORD}
```

### 6.3 GLM 调用 "fetch failed" / EAI_AGAIN

**现象**：backend 日志 `GLM streamChat 失败：fetch failed`，容器内 `node -e "require('dns').lookup('<LLM_HOST>',...)"` 报 `EAI_AGAIN`。

**原因**：宿主机靠 `/etc/hosts` 静态解析 LLM host，Docker 容器内 DNS（127.0.0.11）不继承。

**修复**（已合入 `docker-compose.yml`）：backend 段加：
```yaml
extra_hosts:
  - "${LLM_ENDPOINT_HOST:-llm-endpoint}:${LLM_ENDPOINT_IP:-127.0.0.1}"
```

`.env` 中设 `LLM_ENDPOINT_HOST=<LLM_HOST>` + `LLM_ENDPOINT_IP=<LLM_ENDPOINT_IP>`，
且 `LLM_ENDPOINT_HOST` 须与 `LLM_BASE_URL` 的 host 一致。

### 6.4 backend 镜像缺 RAG 路由（404）

**现象**：`curl /api/knowledge-bases` 返回 404，`docker logs` 无 `KnowledgeBaseController` 路由映射日志。

**原因**：镜像构建于 RAG 代码提交前，或构建不完整。

**修复**：在开发机重新构建镜像（见 §3.1），注意：
- `docker/Dockerfile.backend` 须用 `node:22-bookworm-slim` + `pnpm 11.6.0`（匹配开发环境）
- `server/pnpm-workspace.yaml` 须在 `pnpm install` 前拷贝（`allowBuilds` 白名单）
- `server/nest-cli.json` 须有 `assets` 配置复制 `*.yaml` 到 dist

### 6.5 rag-prompts.yaml 加载失败（降级警告）

**现象**：backend 日志 `加载 rag-prompts.yaml 失败，降级用内置默认 prompt：ENOENT`。

**原因**：`nest build` 不复制非 TS 文件，`rag-prompts.yaml` 未进入 `dist/knowledge-base/`。

**修复**（已合入 `server/nest-cli.json`）：
```json
"compilerOptions": {
  "deleteOutDir": true,
  "assets": [{ "include": "**/*.yaml", "outDir": "dist" }]
}
```

### 6.6 Docker build ERR_PNPM_IGNORED_BUILDS

**现象**：`pnpm install` 报 `Ignored build scripts: @nestjs/core, cpu-features, ...` 并退出非零。

**原因**：pnpm 11 默认阻止依赖执行 install 脚本，须 `allowBuilds` 白名单批准；`pnpm-workspace.yaml` 未在 install 前拷贝到容器。

**修复**（已合入）：
- `docker/Dockerfile.backend` 的 COPY 步骤加 `pnpm-workspace.yaml*`
- `server/pnpm-workspace.yaml` 已入库（不再被 .gitignore 忽略）

### 6.7 docker save "no space left on device"

**原因**：开发机 `/tmp` 是 tmpfs（7.6G），`docker save` 输出到 `/tmp` 不够。

**修复**：输出到工作区或 `/home`（root 分区 240G+ 可用）：
```bash
docker save <image> -o /tmp/opencode/<name>.tar   # /tmp/opencode 在 root 分区
```

---

## 7. 已知限制

| 限制 | 说明 | 规避 |
|------|------|------|
| 生产机无外网 | 不能 docker pull / huggingface 下载 | 镜像 save→scp→load；TEI 模型预导入命名卷 |
| backup 容器未启用 | docker-compose.yml backup 段需构建 alpine，无外网拉不到 | 跳过；用外部备份方案 |
| TEI 无 healthcheck | cpu-1.5 镜像无 curl/wget/python3 | backend 的 embed 重试机制兜底（maxRetries=2） |
| rerank 离线禁用 | 生产机无 rerank 模型 | `.env` 设 `LLM_RERANK_BASE_URL=` 留空，backend 自动跳过回退纯 RRF |
| 开发机 Docker 18.09 | API 版本 1.39，不支持 `docker compose` v2 | 所有命令前加 `DOCKER_API_VERSION=1.39`，用 `docker-compose` v1 |

---

## 8. 快速操作速查

```bash
# 一键同步代码（假设已配 SSH key）
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude '.env' \
  --exclude '参考项目' --exclude 'backups' --exclude 'uploads' \
  -e 'ssh -o StrictHostKeyChecking=accept-new' \
  ./ root@<PROD_HOST>:<PROD_WORKDIR>/

# 一键重建+传输 backend 镜像
DOCKER_API_VERSION=1.39 docker build -f docker/Dockerfile.backend \
  -t ghcr.io/yangzhenyu-123/lxdoc-backend:latest server/ && \
DOCKER_API_VERSION=1.39 docker save ghcr.io/yangzhenyu-123/lxdoc-backend:latest \
  -o /tmp/opencode/lxdoc-backend.tar && \
scp /tmp/opencode/lxdoc-backend.tar root@<PROD_HOST>:/tmp/ && \
ssh root@<PROD_HOST> \
  'docker load -i /tmp/lxdoc-backend.tar && rm /tmp/lxdoc-backend.tar && \
   cd <PROD_WORKDIR> && docker-compose up -d backend' && \
rm /tmp/opencode/lxdoc-backend.tar

# 查看生产机全部容器状态
ssh root@<PROD_HOST> \
  'cd <PROD_WORKDIR> && docker-compose ps'

# 查看某服务日志
ssh root@<PROD_HOST> \
  'docker logs --tail 20 lxdoc-backend'

# 前端可访问性
ssh root@<PROD_HOST> \
  'curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8080/'
```

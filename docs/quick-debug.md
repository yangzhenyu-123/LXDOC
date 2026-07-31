# 快速调试指南

适用于「项目从未跑过、只想最快验证后端 API 是否正常」的场景。**不需要 Docker、不需要前端、不需要 OnlyOffice/docling/LLM**，只要一个 PostgreSQL + Node 即可跑通核心链路。

> 完整功能（编辑/预览/解析/AI 总结）的本地测试见 [部署指南 - 本地开发](./deployment.md#本地开发完整功能测试)。

## 最小环境准备

仅需两样：

1. **PostgreSQL 14+**（提供数据存储 + 全文检索）
2. **Node.js 20+ 与 pnpm 9+**（跑后端）

### 1. 启动 PostgreSQL

任选一种方式：

```bash
# 方式 A：已有 Docker，起一个临时库
docker run -d --name lxdoc-pg -p 5432:5432 \
  -e POSTGRES_USER=lxdoc -e POSTGRES_PASSWORD=lxdoc -e POSTGRES_DB=lxdoc \
  postgres:16-alpine

# 方式 B：裸机 apt 安装（无 Docker 环境）
apt update && apt install -y postgresql
pg_ctlcluster 16 main start 2>/dev/null || service postgresql start
sudo -u postgres psql -c "CREATE USER lxdoc WITH PASSWORD 'lxdoc' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE lxdoc OWNER lxdoc;"
```

验证：`pg_isready -h localhost -p 5432` 返回 `accepting connections` 即可。

### 2. 配置 server/.env

```bash
cd server
cp .env.example .env
```

编辑 `.env`，**只改这几项**指向本地库（其余默认值本地开发可用）：

```bash
DB_HOST=localhost
DB_PORT=5432
DB_USER=lxdoc
DB_PASS=lxdoc
DB_NAME=lxdoc

# 以下可选服务无 Docker 时保持默认（关闭），不影响核心链路
ONLYOFFICE_ENABLED=false
PDF2HTML_URL=
DOCLING_ENABLED=false
LLM_ENABLED=false

# Swagger 调试文档（开发环境默认开启，显式确认）
ENABLE_API_DOCS=true
```

> 本地 `NODE_ENV` 未设置（非 production），故 `JWT_SECRET` / `ONLYOFFICE_JWT_SECRET` / `ADMIN_PASSWORD` 可用默认值，后端不会强校验。

### 3. 启动后端

```bash
cd server
pnpm install
pnpm dev          # 监听 3000，热重载
```

看到以下日志即就绪：

```
API 调试文档已启用：/api/docs
LXDOC 后端服务已启动，监听端口 3000
```

启动时会自动：
- TypeORM `synchronize=true` 自动建表
- 创建 `pg_trgm` 扩展与 GIN 索引
- seed 默认管理员 `admin@lxdoc.local` / `lxdoc12345`
- seed 示例分类（技术文档/解决方案/Bug 分析报告）与组织（研发部/前端组/产品部/需求组）

## 一键 curl 调试核心链路

把下面整段存为 `debug.sh` 直接跑，验证 登录→分类→组织→上传→详情→列表→搜索 全链路：

```bash
#!/usr/bin/env bash
set -e
BASE=http://localhost:3000

echo "=== 1. 健康检查 ==="
curl -s "$BASE/health"; echo

echo "=== 2. 登录拿 token ==="
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@lxdoc.local","password":"lxdoc12345"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")
echo "token 长度: ${#TOKEN}"

AUTH="Authorization: Bearer $TOKEN"

echo "=== 3. 分类列表（取第一个 categoryId）==="
CATEGORY_ID=$(curl -s "$BASE/api/categories" -H "$AUTH" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
echo "categoryId: $CATEGORY_ID"

echo "=== 4. 组织列表 ==="
curl -s "$BASE/api/organizations" -H "$AUTH" | python3 -m json.tool | head -20

echo "=== 5. 上传一个测试 md ==="
cat > /tmp/test-doc.md <<'EOF'
# 调试测试文档
## 简介
验证 上传 解析 存储 搜索 链路。
EOF
DOC_ID=$(curl -s -X POST "$BASE/api/uploads" -H "$AUTH" \
  -F "categoryId=$CATEGORY_ID" -F "file=@/tmp/test-doc.md;type=text/markdown" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "docId: $DOC_ID"

echo "=== 6. 文档详情 ==="
curl -s "$BASE/api/documents/$DOC_ID" -H "$AUTH" | python3 -m json.tool | head -15

echo "=== 7. 最近文档列表 ==="
curl -s "$BASE/api/documents/recent?limit=5" -H "$AUTH" | python3 -m json.tool

echo "=== 8. 全文搜索（关键词：调试）==="
curl -s "$BASE/api/search?q=%E8%B0%83%E8%AF%95" -H "$AUTH" | python3 -m json.tool

echo "=== 全链路验证完成 ==="
```

预期全部返回 HTTP 200，搜索结果 `items` 命中并带 `<mark>` 高亮。看到「全链路验证完成」即核心链路 OK。

## Swagger UI 可视化调试

不想写 curl，直接用浏览器打开：

```
http://localhost:3000/api/docs
```

操作流程：

1. 找到 `POST /api/auth/login` → Try it out → 填 `admin@lxdoc.local` / `lxdoc12345` → Execute，复制响应里的 `accessToken`
2. 点页面右上角 `Authorize` → 填 `Bearer <accessToken>` → Authorize（之后所有接口自动带鉴权）
3. `POST /api/uploads` 支持文件选择框直接选本地文件上传调试
4. OpenAPI JSON `/api/docs-json`、YAML `/api/docs-yaml` 可导入 Postman / Apifox

> `persistAuthorization: true` 已开启，刷新页面不用重新填 token。

## 数据库直连排查

数据不对时直接查库最快：

```bash
# 命令行
PGPASSWORD=lxdoc psql -h localhost -U lxdoc -d lxdoc

# 常用排查语句
\dt                                          # 查看所有表
SELECT id,email,username,role FROM users;    # 用户
SELECT id,name,type,path FROM organizations; # 组织（看 path 是否回填正确）
SELECT id,title,format,version FROM documents; # 文档
SELECT id,name,type FROM categories;         # 分类
```

## 快速重置数据

```bash
# 仅清表数据（保留库与扩展），重启后端会重新 seed
PGPASSWORD=lxdoc psql -h localhost -U lxdoc -d lxdoc -c "
  DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# 然后重启 pnpm dev，TypeORM 会自动重建表 + seed
```

## 已知坑点（首次运行已修复，记录备查）

| 现象 | 原因 | 修复 |
|------|------|------|
| 启动报 `ERR_UNKNOWN_FILE_EXTENSION .js` 或模块找不到 | Node 24 严格 ESM，`package.json` 有 `"type":"module"` 但代码省略 `.js` 扩展名 | `server/tsconfig.json` 改 `"module":"CommonJS"`、`"moduleResolution":"Node"`；`server/package.json` 移除 `"type":"module"` |
| 登录 500，日志 `bcrypt.compare` 收到 undefined | `UsersService.findByEmail` 的 `addSelect` 用了列名 `'user.password_hash'` 而非属性名 | 改为 `qb.addSelect('user.passwordHash')` |
| 启动报 `null value in column "path" violates not-null` | `seedIfEmpty` 创建组织时 `path` 未赋值直接 save | create 时 `path: ''` 占位，save 拿到 id 后再回填 `path = id` 或 `${parent.path}.${id}` |

## 下一步：补齐完整功能

核心链路 OK 后，如需测试编辑/预览/解析/AI 总结，按 [部署指南 - 本地开发](./deployment.md#本地开发完整功能测试) 用 `docker-compose.dev.yml` 启动依赖服务（OnlyOffice/pdf2html/docling）即可，后端无需重启。

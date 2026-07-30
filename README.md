# LXDOC 企业知识库

LXDOC 是一个面向企业的知识库管理系统，支持 Markdown / TXT / DOCX / ODT / PDF 等多种文档格式的上传、解析、在线编辑与全文检索。

## 技术栈

- **后端**：NestJS + TypeORM + PostgreSQL
- **前端**：Vue3 + Vite + Pinia + Vue Router + Element Plus
- **认证授权**：JWT 双 token（access 15min + refresh 7d）+ RBAC（admin/editor/viewer）+ 资源级 ACL + 审计日志
- **文档处理**：Pandoc（DOCX/ODT 转 Markdown）+ pdfjs-dist（PDF 预览）+ Vditor（Markdown 编辑）
- **部署**：Docker + Docker Compose

## 目录结构

```
LXDOC/
├── server/              # 后端 NestJS 服务
├── web/                 # 前端 Vue3 应用
├── docker/              # Dockerfile 与 nginx 配置
├── uploads/             # 上传文件存储（已被 .gitignore 忽略）
│   ├── original/        # 原始文件
│   └── images/          # 解析提取的图片
└── docker-compose.yml   # 一键编排
```

## 一键启动

```bash
docker compose up -d
```

启动后：

- 前端：http://localhost:8080
- 后端 API：http://localhost:3000/api
- PostgreSQL：localhost:5432

## 首次登录

系统首次启动时会自动创建默认管理员账户，请登录后立即修改密码：

| 字段     | 值                   |
|----------|----------------------|
| 邮箱     | admin@lxdoc.local    |
| 密码     | lxdoc12345           |
| 角色     | admin                |

登录后在右上角用户菜单点击「修改密码」即可更换。默认管理员凭据会在后端启动日志中以警告形式输出提示。

## 用户与权限

系统内置三种角色，采用 RBAC + 资源级 ACL 控制：

| 角色   | 读 | 写（创建/编辑/上传）        | 删除                          | 用户管理 / 审计 |
|--------|----|------------------------------|-------------------------------|------------------|
| admin  | ✅ | ✅ 任意资源                  | ✅ 任意资源                   | ✅               |
| editor | ✅ | ✅ 仅自己创建的文档/分类     | ✅ 仅自己创建的文档/分类      | ❌               |
| viewer | ✅ | ❌                           | ❌                            | ❌               |

- 所有 `/api/*` 接口（除登录/注册/health）均需登录
- 自注册默认关闭，需开启时设置环境变量 `ALLOW_SIGNUP=true`
- 关键操作（登录/登出/文档与分类 CRUD/用户管理）均记录审计日志，仅 admin 可查询

## 端口说明

| 服务       | 端口 | 说明                          |
|------------|------|-------------------------------|
| frontend   | 8080 | 前端 Web 入口（nginx 托管）   |
| backend    | 3000 | 后端 NestJS API               |
| postgres   | 5432 | PostgreSQL 数据库             |

## 本地开发

### 后端

```bash
cd server
cp .env.example .env
pnpm install
pnpm dev
```

### 前端

```bash
cd web
pnpm install
pnpm dev
```

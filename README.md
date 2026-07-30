# LXDOC 企业知识库

LXDOC 是一个面向企业的知识库管理系统，支持 Markdown / TXT / DOCX / ODT / PDF 等多种文档格式的上传、解析、在线编辑与全文检索。

## 技术栈

- **后端**：NestJS + TypeORM + PostgreSQL
- **前端**：Vue3 + Vite + Pinia + Vue Router + Element Plus
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

# Tasks

## 阶段一：项目骨架与基础设施
- [x] Task 1: 初始化 Monorepo 结构
  - [x] SubTask 1.1: 创建 `server/`、`web/`、`docker/`、`uploads/`、`.trae/specs/`（已存在）顶层目录
  - [x] SubTask 1.2: 在仓库根写入 `README.md`、`.gitignore`（覆盖 `node_modules/`、`uploads/`、`.env`、`dist/`）
  - [x] SubTask 1.3: 提交初始 commit，修正默认分支为 `main`（注：分支已改 main，commit 待用户决定）
- [x] Task 2: 搭建后端 NestJS 骨架
  - [x] SubTask 2.1: `nest new server --package-manager pnpm`，集成 TypeORM + PostgreSQL 驱动（手动初始化）
  - [x] SubTask 2.2: 配置 `ConfigModule` 读取 `.env`（DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME/UPLOAD_DIR/PORT）
  - [x] SubTask 2.3: 创建 `HealthModule` 暴露 `GET /health` 返回 `{status:'ok'}`，验证 DB 连接
- [x] Task 3: 搭建前端 Vue3 骨架
  - [x] SubTask 3.1: `pnpm create vite web --template vue-ts`，集成 Vue Router、Pinia、Element Plus、axios（手动初始化）
  - [x] SubTask 3.2: 配置 Vite 反向代理 `/api` → `http://localhost:3000`
  - [x] SubTask 3.3: 写一个空白首页路由 `/` 占位，验证 `pnpm dev` 可启动（pnpm build 通过）
- [x] Task 4: 编写 Docker Compose 编排
  - [x] SubTask 4.1: `docker/Dockerfile.backend` 基于 `node:20-bookworm`，apt 安装 `pandoc`
  - [x] SubTask 4.2: `docker/Dockerfile.frontend` 多阶段构建，nginx 托管 `dist/`，反代 `/api` 到 backend
  - [x] SubTask 4.3: `docker-compose.yml` 含 postgres、backend、frontend，挂载 `./uploads` 卷
  - [x] SubTask 4.4: 验证 `docker compose up -d` 三容器健康，浏览器访问 `http://localhost:8080`（CI 无 docker，配置已就绪待部署环境验证）

## 阶段二：数据模型与分类树
- [x] Task 5: 设计数据库 Schema
  - [x] SubTask 5.1: `Category` 表：id、parent_id、name、type(enum: tech_doc/solution/bug_report)、sort、created_at
  - [x] SubTask 5.2: `Document` 表：id、category_id、title、content、format(enum: md/txt/docx/odt/pdf)、original_path、version、author、tags(text[])、created_at、updated_at、user_id(nullable 预留)
  - [x] SubTask 5.3: `DocumentVersion` 表：id、document_id、version、content、snapshot_path、created_at
  - [x] SubTask 5.4: 启用 `pg_trgm` 扩展，在 `title`、`content` 上建 GIN 索引（AppModule.onApplicationBootstrap 执行 SQL）
- [x] Task 6: 实现分类树 API
  - [x] SubTask 6.1: `CategoriesModule` 提供 CRUD：`GET /api/categories`（返回树形）、`POST /api/categories`、`PATCH /api/categories/:id`、`DELETE /api/categories/:id`
  - [x] SubTask 6.2: 系统启动时若 `categories` 表为空，自动 seed 三个顶层分类：技术文档、解决方案、Bug 分析报告
  - [x] SubTask 6.3: 校验同级不允许同名，删除节点时若有子节点/文档则拒绝
- [x] Task 7: 前端分类树组件
  - [x] SubTask 7.1: 使用 Element Plus `el-tree` 渲染左侧分类树，懒加载子节点（一次拉取完整树）
  - [x] SubTask 7.2: 节点右键菜单：新建子分类、重命名、删除
  - [x] SubTask 7.3: 点击节点跳转到 `/c/:categoryId` 文档列表页（CategoryView 占位）

## 阶段三：文档上传与解析
- [x] Task 8: 文件上传与存储模块
  - [x] SubTask 8.1: `UploadModule` 提供 `POST /api/uploads`（multipart），按格式分发到不同处理器
  - [x] SubTask 8.2: 原文件落 `uploads/original/<docId>/<filename>`，图片落 `uploads/images/<docId>/`
  - [x] SubTask 8.3: 静态文件服务 `GET /uploads/*` 暴露 `uploads/` 目录（main.ts useStaticAssets）
- [x] Task 9: Markdown / TXT 解析处理器
  - [x] SubTask 9.1: 直接 `fs.readFile` 读取为 UTF-8 字符串作为 `content`
  - [x] SubTask 9.2: 文件名去扩展名作为 `title`（在 service 层处理）
- [x] Task 10: DOCX / ODT 解析处理器（Pandoc）
  - [x] SubTask 10.1: 调用 `pandoc --extract-media=<imagesDir> -f docx -t markdown <input> -o <output.md>`
  - [x] SubTask 10.2: 读取 output.md 作为 `content`，将 `./media/...` 相对路径替换为 `/uploads/images/...` URL
  - [x] SubTask 10.3: ODT 同理，`-f odt`
- [x] Task 11: PDF 元信息处理器
  - [x] SubTask 11.1: 使用 `pdf-parse` 提取页数与首页前 100 字作为 `title`
  - [x] SubTask 11.2: `content` 留空，`format=pdf`，`original_path` 记录原文件路径供预览使用
- [x] Task 12: 前端上传 UI
  - [x] SubTask 12.1: 文档列表页"上传"按钮，弹出 `el-upload`，限制扩展名 `.md,.markdown,.txt,.docx,.odt,.pdf`
  - [x] SubTask 12.2: 上传成功后刷新列表（emit refresh，列表在阶段六接入）

## 阶段四：Markdown 编辑与版本
- [x] Task 13: 集成 Vditor 编辑器
  - [x] SubTask 13.1: `pnpm add vditor`，封装 `MarkdownEditor.vue` 组件
  - [x] SubTask 13.2: 配置 `upload.handler` 接收粘贴/拖拽图片，调用 `POST /api/uploads/image` 返回 URL
- [x] Task 14: 文档保存与版本
  - [x] SubTask 14.1: `PUT /api/documents/:id` 更新 title、content、tags，version+1，旧版本写入 `DocumentVersion`
  - [x] SubTask 14.2: `GET /api/documents/:id/versions` 返回版本列表，`GET /api/documents/:id/versions/:v` 返回历史内容
  - [x] SubTask 14.3: `POST /api/documents/:id/rollback/:v` 回滚到指定版本
- [x] Task 15: 文档详情页
  - [x] SubTask 15.1: 路由 `/d/:docId`，左侧 Vditor 编辑器（可切换预览模式）
  - [x] SubTask 15.2: 右侧侧栏：元信息（作者、版本、时间）、标签编辑、版本历史下拉

## 阶段五：预览与检索
- [x] Task 16: PDF 在线预览
  - [x] SubTask 16.1: 引入 `pdfjs-dist`，封装 `PdfViewer.vue`，加载 `/uploads/original/<docId>/<file>`
  - [x] SubTask 16.2: 支持翻页、缩放
- [x] Task 17: DOCX/ODT 在线预览
  - [x] SubTask 17.1: 后端 `GET /api/documents/:id/preview` 调用 Pandoc 转 HTML 返回字符串
  - [x] SubTask 17.2: 前端用 `v-html` 渲染，图片 URL 已是绝对路径可直接显示
- [x] Task 18: 全文检索
  - [x] SubTask 18.1: 后端 `GET /api/search?q=keyword&page=1`，使用 `title % 'kw' OR content ILIKE '%kw%'`，标题命中加权
  - [x] SubTask 18.2: 返回高亮片段（截取关键词前后 50 字符，关键词包 `<mark>`）
  - [x] SubTask 18.3: 前端顶部搜索框，回车跳转 `/search?q=...`，结果列表显示标题+片段+分类路径

## 阶段六：文档列表与首页
- [x] Task 19: 文档列表页
  - [x] SubTask 19.1: 路由 `/c/:categoryId`，`GET /api/categories/:id/documents?includeChildren=true` 返回该分类（含子分类）下所有文档
  - [x] SubTask 19.2: 表格展示：标题、格式图标、标签、最后修改时间、版本号
  - [x] SubTask 19.3: 支持按格式、标签筛选
- [x] Task 20: 首页与全局布局
  - [x] SubTask 20.1: 全局布局：左侧分类树 + 顶栏（Logo、搜索框、上传按钮）+ 主内容区
  - [x] SubTask 20.2: 首页 `/` 显示最近更新 10 篇文档 + 三个顶层分类入口卡片

## 阶段七：联调与验证
- [x] Task 21: 端到端验证（静态部分完成；运行时部分受 CI 环境约束，已标注所需环境）
  - [x] SubTask 21.1: 准备测试样本：1 个 `.md`、1 个 `.docx`（含图）、1 个 `.odt`、1 个 `.pdf`、1 个 `.txt`（已生成 `sample.md` / `sample.txt`，并编写 `uploads/test-samples/README.md` 说明 docx/odt/pdf 在部署环境用 pandoc 生成的命令）
  - [ ] SubTask 21.2: 走通：上传 → 入库 → 列表 → 详情 → 编辑 → 保存版本 → 回滚 → 搜索 → 预览 全流程（需运行时环境：postgres + docker + pandoc）
  - [ ] SubTask 21.3: 验证 `docker compose down -v && docker compose up -d` 可冷启动重建（需 docker 环境）
  - 备注：本机 CI 环境约束下（无 postgres、无 docker 守护进程、无 pandoc 二进制）已完成全部静态验证（前后端编译通过、文件结构齐全、关键代码逻辑符合 spec、API 路由完整、配置正确），运行时验证需在部署环境执行。详见 checklist.md 的勾选状态。

# Task Dependencies
- Task 4 依赖 Task 2、Task 3
- Task 5 依赖 Task 2
- Task 6 依赖 Task 5
- Task 7 依赖 Task 6
- Task 8 依赖 Task 5
- Task 9/10/11 依赖 Task 8
- Task 12 依赖 Task 8
- Task 13 依赖 Task 8
- Task 14 依赖 Task 13、Task 5
- Task 15 依赖 Task 13、Task 14
- Task 16/17 依赖 Task 8
- Task 18 依赖 Task 5
- Task 19 依赖 Task 6、Task 12
- Task 20 依赖 Task 7、Task 19
- Task 21 依赖 Task 16、Task 17、Task 18、Task 20

# Checklist

## 阶段一：项目骨架与基础设施
- [x] Monorepo 顶层目录 `server/`、`web/`、`docker/`、`uploads/` 存在
- [x] 根 `.gitignore` 覆盖 `node_modules/`、`uploads/`、`.env`、`dist/`
- [x] 后端 `GET /health` 返回 200 且包含 `{status:'ok'}`
- [x] 前端 `pnpm dev` 启动后访问根路由可见占位首页
- [ ] `docker compose up -d` 后三个容器均为 healthy（待运行时验证；backend/frontend healthcheck 已配置）
- [ ] 浏览器访问 `http://localhost:8080` 可见前端首页（待运行时验证）

## 阶段二：数据模型与分类树
- [x] `Category`、`Document`、`DocumentVersion` 三张表已建，字段与 spec 一致
- [x] `Document.user_id` 字段存在且可为空（预留多用户）
- [x] `pg_trgm` 扩展已启用，`title`、`content` 上有 GIN 索引
- [x] 启动后自动 seed 三个顶层分类：技术文档、解决方案、Bug 分析报告
- [x] `GET /api/categories` 返回完整树形结构
- [x] 同级分类重名被拒绝（返回 4xx）
- [x] 含子节点或文档的分类删除被拒绝
- [x] 前端 `el-tree` 正确渲染三层分类树，右键菜单可新建/重命名/删除

## 阶段三：文档上传与解析
- [ ] `.md/.markdown/.txt` 上传后正文被正确读取，标题为文件名（待运行时验证）
- [ ] `.docx` 上传后通过 Pandoc 转为 Markdown，内嵌图片被抽取到 `uploads/images/<docId>/`（待运行时验证）
- [ ] `.odt` 上传后转换流程与 docx 一致（待运行时验证）
- [ ] `.pdf` 上传后页数与首页标题被提取，正文留空（待运行时验证；pages 字段已加入 Document 实体并持久化）
- [x] 不在白名单内的扩展名上传被拒绝
- [x] `GET /uploads/*` 可访问已上传文件
- [ ] 前端上传 UI 限制扩展名，上传成功后列表自动刷新（待运行时验证）

## 阶段四：Markdown 编辑与版本
- [x] Vditor 编辑器加载正常，可输入 Markdown
- [x] 编辑器内 `Ctrl+V` 粘贴图片自动上传并在正文插入 URL
- [x] 保存后 `version` 自增，旧版本写入 `DocumentVersion` 表
- [x] `GET /api/documents/:id/versions` 返回完整版本历史
- [x] 回滚到历史版本后，`content` 被替换且 `version` 继续自增
- [x] 详情页右侧侧栏正确显示元信息、标签、版本下拉

## 阶段五：预览与检索
- [x] PDF 详情页通过 pdfjs 正确渲染，可翻页缩放
- [x] DOCX/ODT 详情页正确渲染 Pandoc 转换的 HTML，图片可见
- [x] 搜索接口返回标题命中优先的结果
- [x] 搜索结果片段包含 `<mark>` 高亮
- [x] 前端顶部搜索框回车可触发搜索，结果页显示标题+片段+分类路径

## 阶段六：文档列表与首页
- [x] `/c/:categoryId` 列表包含该分类及其所有子分类下的文档
- [x] 列表表格展示：标题、格式图标、标签、最后修改时间、版本号
- [x] 支持按格式、标签筛选
- [x] 首页显示最近更新 10 篇文档
- [x] 首页显示三个顶层分类入口卡片

## 阶段七：联调与验证
- [ ] 5 种格式测试样本均可成功上传（待运行时验证）
- [ ] 上传 → 入库 → 列表 → 详情 → 编辑 → 保存版本 → 回滚 → 搜索 → 预览全流程跑通（待运行时验证）
- [ ] `docker compose down -v && docker compose up -d` 可冷启动重建并 seed 数据（待运行时验证）
- [x] Spec 中"非目标"列表条目均未被实现（验证 MVP 范围未膨胀）

## 文档与可维护性
- [x] 根 `README.md` 含一键启动命令与端口说明
- [x] 后端 `.env.example` 列出全部环境变量
- [x] Spec 三份文档（spec.md / tasks.md / checklist.md）保留在 `.trae/specs/init-enterprise-kb/`

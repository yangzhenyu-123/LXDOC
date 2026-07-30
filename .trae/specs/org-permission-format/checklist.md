# Checklist

## 阶段一：组织层级数据模型与基础设施
- [ ] `Organization` 实体字段齐全：id/parentId/name/type/path/sort/createdAt/updatedAt
- [ ] `path` 物化路径在新建/移动时自动维护，顶层为自身 slug
- [ ] `type=group` 强制有 parent，`type=department` 的 parent 为 null
- [ ] 启动 seed 至少两个示例部门含子组
- [ ] `User.organizationId` 字段+索引存在；seed admin 为 null
- [ ] `user_org_roles` 表存在，UNIQUE(userId,orgId)，role 枚举 editor|admin
- [ ] `CreateUserDto`/`UpdateUserDto` 含 organizationId
- [ ] `Document` 含 ownerType/ownerId/contentSource，复合索引 (ownerType,ownerId)
- [ ] `Category` 含 organizationId（nullable）
- [ ] 迁移脚本：存量 Document ownerType=personal/ownerId=created_by；contentSource 按格式回填
- [ ] `UploadsService.ingest` 支持 ownerType/ownerId 参数

## 阶段二：权限模型与 AccessControlService
- [ ] `AccessControlService.canRead/assertCanRead/canWrite/assertCanWrite` 实现
- [ ] 读规则：personal 仅创建者；group/department 按 org.path 前缀匹配；admin 全读
- [ ] 写规则：personal 创建者；owner 节点或祖先在 UserOrgRole 集合内；admin 全权
- [ ] `getManageableOrgPaths` 带短缓存
- [ ] `readableScopeFilter` 返回参数化 where 片段
- [ ] JWT payload 含 organizationId/orgPath；AuthUser 接口同步
- [ ] login/refresh 签发注入 organizationId/orgPath
- [ ] `findRecent`/`listByCategory` 注入 readableScopeFilter
- [ ] `SearchService` 原生 SQL 注入可见范围 WHERE（参数化）
- [ ] `CategoriesService.findAll` 按 organizationId 过滤
- [ ] `findOne` 读前 assertCanRead
- [ ] documents/categories 两处重复 assertCanWrite 已替换为 AccessControlService

## 阶段三：静态文件鉴权与签名 URL
- [ ] `GET /api/files/:docId/original?token=` 与 image 路由存在
- [ ] 短期 JWT token 含 docId+过期，FILE_TOKEN_EXPIRES 可配
- [ ] controller 内 assertCanRead 后 sendFile
- [ ] `main.ts` 已移除 useStaticAssets('/uploads') 裸暴露
- [ ] 前端所有 /uploads/ 引用改为 /api/files/...?token=（图片经工具函数拼 token）

## 阶段四：组织管理 API 与前端
- [ ] 组织树 CRUD 接口齐全，写操作权限校验（admin 或父节点 admin 角色）
- [ ] 删除组织校验无子节点无文档；同级重名拒绝；移动重算子树 path
- [ ] 成员管理接口齐全，含 @Audit
- [ ] `/admin/organizations` 页 el-tree 渲染 + 右键菜单
- [ ] 节点详情抽屉成员表格可加/改/删成员
- [ ] 用户管理页含"所属组织"列与编辑
- [ ] 上传对话框含"归属"选择（个人/我的组/我的部门）

## 阶段五：PDF 全文入库与版式增强
- [ ] `pdf.parser.ts` 把 data.text 完整存 content，contentSource=pdf_text
- [ ] 迁移脚本回填存量 PDF content
- [ ] backend Dockerfile 安装 pdf2htmlEX
- [ ] `GET /api/documents/:id/pdf-html` 生成并缓存 HTML，输出已 sanitize
- [ ] PdfViewer 增加文本层，文字可选可复制
- [ ] backend Dockerfile 安装 libreoffice
- [ ] `POST /api/documents/:id/convert-to-editable` 产出新 md 文档，owner 继承
- [ ] 前端 PDF 详情页三 tab（版式/翻页/编辑文本）+ 转可编辑按钮
- [ ] PDF 转换有 @Audit(PDF_CONVERT)

## 阶段六：docx OnlyOffice 集成
- [ ] docker-compose 含 onlyoffice 服务，JWT_ENABLED + JWT_SECRET
- [ ] onlyoffice ↔ backend 网络打通；nginx 反代 /onlyoffice/
- [ ] `GET /api/documents/:id/onlyoffice/config` 生成 JWT 签名 config，含签名文件 URL
- [ ] `POST /api/documents/:id/onlyoffice/callback` 校验 token，status=6 覆盖文件+version+1+快照+重抽索引
- [ ] docx 上传 content 存 pandoc 纯文本（contentSource=pandoc），不作可编辑 markdown
- [ ] DocumentView format=docx 挂载 OnlyOfficeEditor，按权限 mode
- [ ] OnlyOfficeEditor.vue 动态注入 api.js 正常加载
- [ ] mammoth 降级显示在 OnlyOffice 不可用时生效
- [ ] VITE_ONLYOFFICE_URL 配置生效

## 阶段七：LLM 架构骨架
- [ ] llm-provider.interface.ts 定义 chat/embed/streamChat
- [ ] glm.provider.ts 实现（OpenAI 兼容假设），走 env
- [ ] LLM_ENABLED=false 时模块不启用，@OptionalLlm 返回 null
- [ ] `GET /api/llm/health`（admin）连通性探测
- [ ] .env.example 含 LLM_BASE_URL/API_KEY/MODEL/TIMEOUT/EMBED_MODEL
- [ ] RAG 预留仅文档（pgvector 启用步骤、embedding 字段规划）

## 阶段八：联调与验证
- [ ] 后端 `pnpm build` 通过
- [ ] 前端 `pnpm build` 通过
- [ ] 静态校验：所有读接口含 readableScopeFilter；静态文件经鉴权
- [ ] 运行时：用户 A 能读本部门、不能读他部门文档（403）
- [ ] 运行时：editor 有授权可改组内文档，无授权 403
- [ ] 运行时：PDF 上传后可全文检索 + 版式预览 + 转可编辑
- [ ] 运行时：docx OnlyOffice 可查看/编辑，保存后 version+1
- [ ] 运行时：静态文件无 token 返回 401
- [ ] `docker compose up -d` 全部容器 healthy（含 onlyoffice）
- [ ] 已提交并推送到 origin/main

## 文档与可维护性
- [ ] server/.env.example 含 OnlyOffice/PDF/LLM 全部新增变量
- [ ] README 更新组织权限说明、OnlyOffice/LibreOffice 部署依赖
- [ ] 三份 spec 文档保留在 .trae/specs/org-permission-format/
- [ ] Spec 中"非目标"条目均未被实现（范围未膨胀）

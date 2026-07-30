# Tasks

## 阶段一：组织层级数据模型与基础设施
- [ ] Task 1: Organization 实体与迁移
  - [ ] SubTask 1.1: 新建 `server/src/organizations/organization.entity.ts`：id/parentId/name/type(department,group)/path/sort/createdAt/updatedAt
  - [ ] SubTask 1.2: `path` 物化路径，新建/移动节点时自动维护（`父path.本节点slug`），顶层为自身 slug
  - [ ] SubTask 1.3: 约束校验：group 必须有 parent；department 的 parent 为 null
  - [ ] SubTask 1.4: 启动 seed 两个示例部门（研发部 / 产品部）各含一个组，便于联调
- [ ] Task 2: User/UserOrgRole 实体扩展
  - [ ] SubTask 2.1: `User` 新增 `organizationId` 字段 + 索引
  - [ ] SubTask 2.2: 新建 `user_org_roles` 表实体：userId/orgId/role(editor,admin)/createdAt，UNIQUE(userId,orgId)
  - [ ] SubTask 2.3: `CreateUserDto`/`UpdateUserDto` 增加 `organizationId`；`UsersService` CRUD 处理
  - [ ] SubTask 2.4: seed admin 用户 `organizationId=null`
- [ ] Task 3: Document/Category 实体扩展
  - [ ] SubTask 3.1: `Document` 新增 `ownerType`(personal,group,department) / `ownerId` / `contentSource`(manual,pandoc,pdf_text,onlyoffice)，复合索引 (ownerType,ownerId)
  - [ ] SubTask 3.2: `Category` 新增 `organizationId`（nullable，公共树为 null）
  - [ ] SubTask 3.3: 迁移脚本：存量 Document `ownerType='personal'`、`ownerId=created_by`；md/txt→manual，docx→pandoc，pdf→pdf_text（占位，全文回填在阶段五）
  - [ ] SubTask 3.4: `UploadsService.ingest` 接收 `ownerType`/`ownerId` 参数，默认 personal

## 阶段二：权限模型与 AccessControlService
- [x] Task 4: 抽象 AccessControlService
  - [x] SubTask 4.1: 新建 `server/src/organizations/access-control.service.ts`：`canRead`/`assertCanRead`/`canWrite`/`assertCanWrite`
  - [x] SubTask 4.2: 实现读规则：personal 仅创建者；group/department 按 `org.path` 前缀匹配用户所属节点；admin 全读
  - [x] SubTask 4.3: 实现写规则：personal 创建者；owner 节点或其祖先在 `UserOrgRole`(editor|admin) 集合内；admin 全权
  - [x] SubTask 4.4: `getManageableRoles(userId)`：查 UserOrgRole 得授权节点 path 集合，带 30s 内存缓存
  - [x] SubTask 4.5: `applyReadScopeToQb` / `getReadScope` 返回参数化条件，供读接口复用
- [x] Task 5: 扩展 JWT 载荷与 AuthUser
  - [x] SubTask 5.1: `jwt.strategy.ts` validate 返回 `{id, role, organizationId, orgPath}`
  - [x] SubTask 5.2: `AuthUser` 接口同步扩展；登录时查 User 拿 organizationId + join org 拿 path
  - [x] SubTask 5.3: `auth.service.ts` login/refresh 签发时注入 organizationId/orgPath 到 payload
- [x] Task 6: 读路径注入 ACL
  - [x] SubTask 6.1: `DocumentsService.findRecent` / `listByCategory` 追加 `applyReadScopeToQb`
  - [x] SubTask 6.2: `SearchService` 原生 SQL 追加可见范围 WHERE（参数化防注入）
  - [x] SubTask 6.3: `CategoriesService.findAll` 按 organizationId 过滤（公共树 + 本组织子树）
  - [x] SubTask 6.4: `DocumentsService.findOne` 读前 `assertCanRead`
  - [ ] SubTask 6.5: 用 `assertCanWrite` 替换 categories 重复私有方法（categories 仍按 createdBy 判断，组织级编辑授权后续按需接入）

## 阶段三：静态文件鉴权与签名 URL
- [x] Task 7: 文件下载鉴权
  - [x] SubTask 7.1: 新建 `FilesController` `GET /api/files/:docId/original?token=` 与 `/api/files/:docId/image/:name?token=`
  - [x] SubTask 7.2: 短期 JWT token（含 docId+过期），`FILE_TOKEN_EXPIRES` 配置
  - [x] SubTask 7.3: controller 内 `assertCanRead(docId)` 后 `res.sendFile`
  - [x] SubTask 7.4: 移除 `main.ts` 的 `useStaticAssets('/uploads')` 裸暴露
  - [x] SubTask 7.5: 前端所有 `/uploads/...` 引用改为 `/api/files/...?token=`（图片通过统一工具函数拼 token）

## 阶段四：组织管理 API 与前端
- [ ] Task 8: 组织 CRUD API
  - [ ] SubTask 8.1: `OrganizationsModule`/`Controller`/`Service`：树查询、新建、改名、删除
  - [ ] SubTask 8.2: 写操作权限：admin 或父节点 admin 角色；删除校验无子节点无文档
  - [ ] SubTask 8.3: 同级重名校验；移动节点时重算子树 path
- [ ] Task 9: 成员管理 API
  - [ ] SubTask 9.1: `GET/POST /api/organizations/:id/members`、`PATCH/DELETE /api/organizations/:id/members/:userId`
  - [ ] SubTask 9.2: 权限：admin 或该节点 admin 角色
  - [ ] SubTask 9.3: `@Audit()` 记录成员变更
- [ ] Task 10: 前端组织管理页
  - [ ] SubTask 10.1: `web/src/api/organizations.ts` 接口
  - [ ] SubTask 10.2: `/admin/organizations` 页：el-tree 渲染组织树 + 右键新建/改名/删除
  - [ ] SubTask 10.3: 节点详情抽屉：成员表格 + 加成员/改角色/移除
  - [ ] SubTask 10.4: 用户管理页增加"所属组织"列与编辑
  - [ ] SubTask 10.5: 文档上传对话框增加"归属"选择（个人 / 我的组 / 我的部门）

## 阶段五：PDF 全文入库与版式增强
- [ ] Task 11: PDF 全文入库
  - [ ] SubTask 11.1: `pdf.parser.ts` 把 `data.text` 完整存入 `content`，`contentSource='pdf_text'`
  - [ ] SubTask 11.2: 迁移脚本：存量 pdf 文档重跑 pdf-parse 回填 content
- [ ] Task 12: 版式保真显示
  - [ ] SubTask 12.1: backend Dockerfile 安装 `pdf2htmlEX`（或 poppler-utils 依赖）
  - [ ] SubTask 12.2: `GET /api/documents/:id/pdf-html`：调用 pdf2htmlEX 生成 HTML，缓存到 `uploads/cache/<docId>/pdf.html`，返回字符串
  - [ ] SubTask 12.3: HTML 输出 sanitize（去 script）后返回
  - [ ] SubTask 12.4: 前端 PdfViewer 增加文本层（pdfjs TextLayer）使文字可选
- [ ] Task 13: PDF 转可编辑
  - [ ] SubTask 13.1: backend Dockerfile 安装 `libreoffice`
  - [ ] SubTask 13.2: `POST /api/documents/:id/convert-to-editable`：soffice pdf→docx → pandoc docx→md，产出新 md 文档（owner 继承）
  - [ ] SubTask 13.3: 前端 PDF 详情页三 tab：版式预览 / 翻页预览 / 编辑文本；顶部"转为可编辑文档"按钮
  - [ ] SubTask 13.4: `@Audit(PDF_CONVERT)`

## 阶段六：docx OnlyOffice 集成
- [ ] Task 14: OnlyOffice 部署
  - [ ] SubTask 14.1: `docker-compose.yml` 新增 `onlyoffice` 服务（onlyoffice/documentserver），JWT_ENABLED + JWT_SECRET
  - [ ] SubTask 14.2: 网络打通：onlyoffice ↔ backend（callback + 文件 URL）
  - [ ] SubTask 14.3: nginx（frontend）反代 `/onlyoffice/` 到 onlyoffice 容器
- [ ] Task 15: 后端 OnlyOffice 接口
  - [ ] SubTask 15.1: `GET /api/documents/:id/onlyoffice/config?mode=`：读/写权限校验，生成 config（含签名文件 URL、callbackUrl、user），JWT 签名整体 config
  - [ ] SubTask 15.2: `POST /api/documents/:id/onlyoffice/callback`：校验 OnlyOffice JWT token；status=6 时下载 url → 覆盖 originalPath → version+1 → 写 DocumentVersion → 异步重抽索引文本
  - [ ] SubTask 15.3: `FilesController` 增加 OnlyOffice 可达的签名 URL 签发
- [ ] Task 16: docx 上传流程调整
  - [ ] SubTask 16.1: docx 上传后 `content` 存 pandoc 抽取的纯文本（`content_source='pandoc'`），不再作为可编辑 markdown
  - [ ] SubTask 16.2: `DocumentView.vue` format=docx 分支：挂载 OnlyOfficeEditor，按权限 mode=view|edit
- [ ] Task 17: 前端 OnlyOffice 组件
  - [ ] SubTask 17.1: 新建 `OnlyOfficeEditor.vue`：动态注入 `api.js`，`new DocsAPI.DocEditor`
  - [ ] SubTask 17.2: 引入 `mammoth` 作为 OnlyOffice 不可用时的只读降级显示
  - [ ] SubTask 17.3: `VITE_ONLYOFFICE_URL` 配置；config 接口对接

## 阶段七：LLM 架构骨架（不接业务）
- [ ] Task 18: LLM 模块骨架
  - [ ] SubTask 18.1: `server/src/llm/llm-provider.interface.ts`：chat/embed/streamChat 接口定义
  - [ ] SubTask 18.2: `providers/glm.provider.ts`：GLM5.2 实现（假设 OpenAI 兼容，axios 调用），走 env 配置
  - [ ] SubTask 18.3: `llm.module.ts`：`LLM_ENABLED=false` 时不启用，`@OptionalLlm()` 装饰器返回 null
  - [ ] SubTask 18.4: `GET /api/llm/health`（admin）：探测内网连通性
  - [ ] SubTask 18.5: `.env.example` 补全 LLM 配置项
- [ ] Task 19: RAG 预留（仅文档，不实现）
  - [ ] SubTask 19.1: spec 记录 pgvector 启用步骤、Document.embedding 字段规划，标注为后续迭代

## 阶段八：联调与验证
- [ ] Task 20: 端到端验证
  - [ ] SubTask 20.1: 后端 `pnpm build` 通过
  - [ ] SubTask 20.2: 前端 `pnpm build` 通过
  - [ ] SubTask 20.3: 静态校验：所有读接口含 readableScopeFilter；静态文件经鉴权
  - [ ] SubTask 20.4: 运行时验证（需 docker + onlyoffice + libreoffice + pdf2htmlEX）：
    - 组织树 CRUD + 成员授权
    - 用户 A 属 dept-a，能读 dept-a 文档、不能读 dept-c 文档
    - editor 有授权可改组内文档，无授权被拒 403
    - PDF 上传后可全文检索 + 版式预览 + 转可编辑
    - docx 上传后 OnlyOffice 可查看/编辑、保存后版本+1
    - 静态文件无 token 401
  - [ ] SubTask 20.5: `docker compose up -d` 含 onlyoffice 全部健康
  - [ ] SubTask 20.6: 提交并推送

# Task Dependencies
- Task 2/3 依赖 Task 1
- Task 4 依赖 Task 1/2/3
- Task 5 依赖 Task 2
- Task 6 依赖 Task 4/5
- Task 7 依赖 Task 4
- Task 8/9 依赖 Task 1/2/4
- Task 10 依赖 Task 8/9
- Task 11 独立（可先行）
- Task 12/13 依赖 Task 11/7
- Task 14 独立（部署）
- Task 15 依赖 Task 7/14
- Task 16/17 依赖 Task 15
- Task 18 独立（骨架）
- Task 20 依赖全部

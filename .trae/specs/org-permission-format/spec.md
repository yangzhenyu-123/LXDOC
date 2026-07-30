# Spec：组织层级权限 + 文档格式增强 + LLM 接入规划

> 本 spec 是 `add-user-rbac`（已完成：JWT + RBAC + 个人 ACL + 审计）的演进。在已有角色体系之上引入"部门/组/个人"层级权限，并把 docx/pdf 的处理从"有损 markdown 衍生"升级为"原格式直接编辑/显示"。LLM 部分为架构规划，本期不落业务代码。

## 实施进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| 阶段一~四 | 组织树/权限模型/静态文件鉴权/前端管理页 | ✅ 已完成 |
| 阶段五 | PDF 全文入库 + 版式保真显示 + 转可编辑 | ✅ 已完成 |
| 阶段六 | docx OnlyOffice 真编辑集成 | ✅ 已完成 |
| 阶段七 | LLM 架构骨架（Provider 抽象 + GLM5.2 接入点 + health 接口） | ✅ 已完成 |
| 阶段八 | 编译验证 + .env / docker-compose / nginx 配置补全 | ✅ 已完成 |
| 后续迭代 | 上传后摘要/自动标签、RAG 向量检索、编辑器内助手 | 📌 待规划 |

---

## 1. 背景与目标

### 1.1 现状痛点
- 权限仅 `role + createdBy` 个人归属，**读接口零 ACL**，任何登录用户可读全部文档；无部门/组隔离。
- docx 经 pandoc 转 markdown，**有损**，"导入格式乱"；编辑的是衍生 markdown 而非原 docx。
- pdf-parse 已提取全文 `data.text` 但**被丢弃**（content=null），导致 PDF 全文检索失效、不可编辑；预览为 canvas 位图，文字不可选。
- `/uploads/original/**` 静态文件无鉴权，URL 直连即可下载，权限隔离后是安全漏洞。

### 1.2 本期目标
1. **组织层级权限**：通用组织树（部门 > 组），个人为用户私有空间；每层有读权限，编辑需对应编辑授权。
2. **docx 原格式编辑/显示**：接入 OnlyOffice Document Server，浏览器内直接编辑 docx、保留原格式。
3. **PDF 显示 + 转可编辑**：全文入库（修复检索）+ 版式保真显示 + 一键转可编辑文档。
4. **LLM 接入架构规划**：抽象 Provider 接口，为内网 GLM5.2 预留接入点（仅架构，不接业务）。

### 1.3 非目标
- 不做实时协同编辑（OnlyOffice 单人编辑即可，多人冲突由其锁机制处理）。
- 不替换现有 Vditor markdown 编辑器（md/txt 仍用 Vditor；docx 走 OnlyOffice）。
- 不实现 GLM 业务功能（摘要/RAG/助手均为后续迭代）。
- 不做扫描件 OCR（本期 PDF 仅处理文本型；OCR 留扩展点）。

---

## 2. 数据模型变更

### 2.1 新增 `Organization` 实体（通用树）
```
organizations
  id          uuid PK
  parent_id   uuid nullable  -- 父节点，顶层部门为 null
  name        varchar(100)
  type        enum(department, group)  -- 部门 | 组
  path        ltree 或 varchar  -- 物化路径，如 'dept-a.group-b'，加速祖先/子孙查询
  sort        int default 0
  created_at  timestamptz
  updated_at  timestamptz
```
- 单表自引用树，`type` 区分部门（顶层）/组（子层）。
- `path` 用 varchar 存物化路径（点号分隔），读 ACL 用 `LIKE '前缀%'` 匹配，避免递归 CTE。
- 约束：`type=group` 必须有 `parent_id`；`type=department` 的 `parent_id` 为 null。

### 2.2 `User` 实体扩展
- 新增 `organization_id uuid nullable`：用户所属组织节点（通常指向某个 group）。
- 索引：`organization_id`。
- 现有 admin seed 用户 `organization_id` 为 null（全局管理员，不属任何部门）。

### 2.3 新增 `UserOrgRole` 关联表（编辑授权）
```
user_org_roles
  id            uuid PK
  user_id       uuid  -- 用户
  org_id        uuid  -- 组织节点
  role          enum(editor, admin)  -- 在该节点的角色
  created_at    timestamptz
  UNIQUE(user_id, org_id)
```
- 用户对某 org 节点有 `editor` 角色 → 可编辑该节点及其子孙下的文档。
- `admin` 角色 → 可编辑 + 可管理该节点成员与子节点。
- 全局 `UserRole.ADMIN` 仍全权，不受此表约束。

### 2.4 `Document` 实体扩展
- 新增 `owner_type enum(personal, group, department) default 'personal'`。
- 新增 `owner_id uuid nullable`：
  - `personal` → 创建者 user id
  - `group`/`department` → organization id
- 保留 `created_by`（记录实际创建人，不变）。
- 索引：`(owner_type, owner_id)` 复合索引。
- 迁移：存量文档 `owner_type='personal'`、`owner_id=created_by`。

### 2.5 `Category` 扩展（可选挂组织）
- 新增 `organization_id uuid nullable`：分类树可挂到某组织节点；null 表示公共分类树。
- 现有三个种子顶层分类保持 `organization_id=null`（全站公共）。

### 2.6 `Document` 新增 `content_source` 字段（区分正文来源）
- 新增 `content_source enum(manual, pandoc, pdf_text, onlyoffice) default 'manual'`：
  - `manual`：用户手写/编辑的 markdown/txt
  - `pandoc`：docx 经 pandoc 抽取的**索引文本**（仅用于检索，不再作为编辑正文）
  - `pdf_text`：pdf-parse 提取的全文
  - `onlyoffice`：docx 由 OnlyOffice 回写（本期 content 不存 docx 二进制，仅标记来源）
- 用途：前端据此决定 docx 走 OnlyOffice 而非 Vditor；搜索据此决定是否纳入全文索引。

---

## 3. 权限模型设计

### 3.1 读取权限（每层有读权限）
用户可见文档集合 = `个人文档` ∪ `所属组织子树文档` ∪ `admin 全读`：
- `personal` 文档：仅 `created_by = 当前用户` 或 admin 可读。
- `group`/`department` 文档：用户 `organization_id` 所在节点的 `path` 是该文档 `owner` 节点 path 的前缀（即用户属于该 owner 节点或其祖先节点），则可读。
  - 例：用户属 `dept-a.group-b`（path=`dept-a.group-b`），可读 owner 为 `dept-a`（path=`dept-a`）和 `dept-a.group-b` 的文档；不可读 `dept-c` 的文档。
- admin 全读。

### 3.2 编辑权限（需对应编辑权限）
用户可编辑文档当且仅当：
- admin（全局）；或
- `personal` 文档且 `created_by = 当前用户`；或
- 文档 `owner` 节点在用户的 `UserOrgRole` 授权集合内（含子孙继承），且角色为 `editor` 或 `admin`；或
- 用户对该文档 owner 的任一**祖先**节点有 `admin` 角色（向下继承）。

### 3.3 抽象 `AccessControlService`
替代当前 `documents.service.ts` 与 `categories.service.ts` 各自重复的 `assertCanWrite`：
```ts
class AccessControlService {
  canRead(user, doc): boolean;
  assertCanRead(user, doc): void;          // 抛 403
  canWrite(user, doc): boolean;
  assertCanWrite(user, doc): void;
  readableScopeFilter(user): { conditions, params };  // 注入到查询 WHERE
}
```
- `readableScopeFilter` 返回 TypeORM 可用的 where 片段，供 `findRecent`/`listByCategory`/`search` 复用，避免每个读接口手写过滤。

### 3.4 JWT 载荷与 AuthUser 扩展
- `jwt.strategy.ts` validate 返回扩展为 `{ id, role, organizationId, orgPath }`。
- `AuthUser` 接口同步扩展。
- 编辑授权的 `manageableOrgIds`/`manageableOrgPaths` 在请求时由 `AccessControlService` 从 `UserOrgRole` 表即时查询（避免 JWT 过大与权限变更不及时），可加短时缓存。

### 3.5 静态文件鉴权
- `/uploads/original/**` 与 `/uploads/images/**` 不再裸暴露。
- 改为经 controller 路由 `GET /api/files/:docId/:filename`，由 `AccessControlService.assertCanRead` 校验后再 `res.sendFile`。
- OnlyOffice 拉取 docx 用**签名 URL**（短期 token），见 §4。

---

## 4. docx 原格式编辑/显示（OnlyOffice 集成）

### 4.1 部署
- `docker-compose.yml` 新增 `onlyoffice` 服务：`onlyoffice/documentserver:latest`。
- 环境变量 `JWT_ENABLED=true` + `JWT_SECRET`（与后端共享）。
- 网络：OnlyOffice 容器需能访问后端 callback URL 与 docx 文件 URL；后端需能被 OnlyOffice 回调。

### 4.2 后端接口
- `GET /api/documents/:id/onlyoffice/config`：
  - 校验读权限；若进入编辑态再校验写权限（query `?mode=edit`）。
  - 返回 OnlyOffice 前端初始化 config：
    ```json
    {
      "document": {
        "fileType": "docx", "key": "<docId>#v<version>",
        "title": "xxx.docx",
        "url": "<签名 URL，后端生成，短期有效，指向 /api/files/...>"
      },
      "editorConfig": {
        "mode": "edit|view",
        "callbackUrl": "<后端 /api/documents/:id/onlyoffice/callback>",
        "user": { "id", "name" },
        "lang": "zh"
      },
      "token": "<JWT 签名后的整个 config>"
    }
    ```
  - `document.key` 每次保存后版本号变化，强制 OnlyOffice 重新加载。
- `POST /api/documents/:id/onlyoffice/callback`：
  - OnlyOffice 在保存时回调，body 含 `url`（新文件下载地址）与 `status`（2=保存中，6=强制保存完成等）。
  - 后端用 **OnlyOffice JWT secret** 校验回调 `token`。
  - status=6 时：下载 `url` 内容 → 覆盖 `originalPath` 文件 → `version+1` → 写 `DocumentVersion` 快照 → 异步重新抽取索引文本（pandoc→text）更新 `content`。
- 签名 URL：`GET /api/files/:docId/original?token=<短期JWT>`，token 含 docId + 过期时间，OnlyOffice 用它拉取文件，绕过 session 鉴权。

### 4.3 docx 上传流程调整
- 上传 docx 仍存原文件到 `originalPath`。
- **不再**把 pandoc markdown 作为可编辑 `content`；改为用 pandoc 抽取**纯文本**存 `content`（`content_source='pandoc'`），仅供全文检索。
- 详情页 docx：嵌入 OnlyOffice（编辑/查看），不显示 Vditor。
- "格式乱"问题由 OnlyOffice 原格式渲染根治。

### 4.4 前端
- 新增 `OnlyOfficeEditor.vue`：动态注入 OnlyOffice `api.js`（`<script src="http://onlyoffice/web-apps/apps/api/documents/api.js">`），`new DocsAPI.DocEditor(el, config)`。
- `DocumentView.vue`：`format=docx` 分支改为挂载 `OnlyOfficeEditor`，按权限传 `mode=view|edit`。
- 配置 OnlyOffice 服务地址 via env `VITE_ONLYOFFICE_URL`。

### 4.5 离线/降级
- 若 OnlyOffice 服务不可用，docx 详情页回退到 mammoth.js 只读显示 + 提示"编辑服务不可用"。
- 前端引入 `mammoth` 作为查看降级（轻量，仅显示）。

---

## 5. PDF 显示 + 转可编辑

### 5.1 全文入库（修复检索，改动最小）
- `pdf.parser.ts`：把 `data.text` 完整存入 `content`（不再丢弃），`content_source='pdf_text'`。
- 标题仍取前 100 字。`pages` 保留。
- 收益：PDF 立即可全文检索；`content` 可作为基础可编辑文本。

### 5.2 版式保真显示
- 引入 `pdf2htmlEX`（服务端二进制，Docker 安装）：`pdf2htmlEX --zoom 1.3 input.pdf output.html`，产出保留版式的 HTML。
- 新增 `GET /api/documents/:id/pdf-html`：按需生成（首次生成缓存到 `uploads/cache/<docId>/pdf.html`），返回 HTML 字符串供前端 `v-html`（需 sanitize）。
- 前端 PDF 详情页增加"原样预览"tab，展示版式 HTML；保留现有 pdfjs canvas 作为"翻页预览"tab，并为其加文本层（`pdfjs-dist` TextLayer）使文字可选。

### 5.3 转为可编辑
- 新增 `POST /api/documents/:id/convert-to-editable`：
  - 用 LibreOffice headless：`soffice --headless --convert-to docx --outdir <tmp> <pdf>`，再 pandoc `docx→markdown`。
  - 产出的 markdown 作为**新文档**（`format=md`，`title=原标题(可编辑)`，`owner` 继承原文档），原 PDF 保留不动。
  - 或作为原文档的新版本（`content_source='manual'`），由前端选择。
- Docker 安装 `libreoffice`（已含 soffice）。

### 5.4 前端 PDF 详情页改造
- 三个 tab：`版式预览`（pdf2htmlEX HTML）/ `翻页预览`（pdfjs+文本层）/ `编辑文本`（Vditor 编辑 content）。
- 顶部"转为可编辑文档"按钮（需写权限）。

---

## 6. LLM 接入架构规划（本期仅架构，不接业务）

### 6.1 模块结构
```
server/src/llm/
  llm-provider.interface.ts   // chat(messages,opts) / embed(text) / streamChat(...)
  providers/glm.provider.ts   // 内网 GLM5.2 实现
  llm.module.ts
  llm.service.ts              // 编排：摘要/标签/问答（本期仅骨架）
  config/llm.config.ts        // LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_TIMEOUT / LLM_EMBED_MODEL
```

### 6.2 设计原则
- Provider 接口与具体模型解耦，GLM5.2 是一个实现；后续可换其他模型。
- GLM5.2 内网 API 格式需确认（假设 OpenAI 兼容 chat/completions；若有 embedding 接口则用之，否则跳过 RAG 向量部分）。
- 所有调用走 env 配置，超时/限流/熔断；失败不阻断主流程（异步任务）。
- 预留 `@OptionalLlm()` 装饰器，业务模块按需注入（LLM 未配置时返回 null，不报错）。

### 6.3 后续分期（非本期）
1. 连通性：LLM 模块 + GLM Provider + 健康检查 `GET /api/llm/health`。
2. 上传后异步生成摘要 + 自动标签（写 `Document.summary` 新字段）。
3. RAG：启用 `pgvector`，`Document.embedding vector`，语义检索 + 带引用问答（SSE 流式）。
4. 编辑器内助手（侧栏对话 / 补全）。

### 6.4 待确认信息
- 内网 GLM5.2 端点、认证方式、是否 OpenAI 兼容。
- 是否提供 embedding 接口及其维度。
- 上下文窗口、并发与限流策略。
- 是否需要走内网代理。

---

## 7. API 设计（新增/变更摘要）

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/api/organizations` | 组织树 | 登录 |
| POST | `/api/organizations` | 新建节点 | admin 或父节点 admin 角色 |
| PATCH | `/api/organizations/:id` | 改名/排序 | admin 或该节点 admin 角色 |
| DELETE | `/api/organizations/:id` | 删除（无子节点无文档） | admin 或该节点 admin 角色 |
| GET | `/api/organizations/:id/members` | 成员列表 | admin 或该节点 admin 角色 |
| POST | `/api/organizations/:id/members` | 加成员+角色 | admin 或该节点 admin 角色 |
| PATCH | `/api/organizations/:id/members/:userId` | 改成员角色 | admin 或该节点 admin 角色 |
| DELETE | `/api/organizations/:id/members/:userId` | 移除成员 | admin 或该节点 admin 角色 |
| GET | `/api/documents/:id/onlyoffice/config` | OnlyOffice 配置 | 读（edit 模式需写） |
| POST | `/api/documents/:id/onlyoffice/callback` | 保存回调 | OnlyOffice JWT 校验 |
| GET | `/api/files/:docId/original?token=` | 签名文件下载 | 短期 token |
| GET | `/api/documents/:id/pdf-html` | PDF 版式 HTML | 读 |
| POST | `/api/documents/:id/convert-to-editable` | PDF 转 md 新文档 | 写 |
| GET | `/api/llm/health` | LLM 连通性 | admin |

变更：所有文档/分类/搜索读接口注入 `readableScopeFilter`；`/uploads/*` 静态路由移除，统一走 `/api/files`。

---

## 8. 配置项（.env 新增）

```
# 组织权限（无新增 env，走数据库）

# OnlyOffice
ONLYOFFICE_URL=http://onlyoffice
ONLYOFFICE_JWT_SECRET=change-me
FILE_TOKEN_EXPIRES=60

# PDF 工具（系统二进制，Docker 安装）
PDF2HTML_BIN=pdf2htmlEX
SOFFICE_BIN=soffice

# LLM（本期仅骨架）
LLM_ENABLED=false
LLM_BASE_URL=http://internal-glm/v1
LLM_API_KEY=
LLM_MODEL=glm-5.2
LLM_TIMEOUT=30000

# 前端
VITE_ONLYOFFICE_URL=http://localhost:8080/onlyoffice
```

---

## 9. 迁移与兼容

1. 存量 `Document`：`owner_type='personal'`、`owner_id=created_by`、`content_source`：md/txt→`manual`，docx→`pandoc`，pdf→`pdf_text`（需回填，对存量 pdf 重新跑 pdf-parse 提取全文）。
2. 存量 `User`：`organization_id=null`（管理员后续分配）。
3. 存量 `Category`：`organization_id=null`（公共树）。
4. 静态文件路由变更：前端所有 `/uploads/...` 引用改为 `/api/files/...`；图片可保留 `/api/files/image?path=` 形式。
5. docker-compose 新增 onlyoffice 服务；backend Dockerfile 增加 `pdf2htmlEX`、`libreoffice`、`poppler-utils` 安装。
6. 数据库迁移脚本（TypeORM synchronize=false 时手写 migration）：organizations、user_org_roles 表，user/document/category 字段。

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| OnlyOffice AGPL 许可 | 仅自用/内部部署合规；若商业发行需购买商业版 |
| OnlyOffice 资源占用高 | 限制并发编辑数；非 docx 不启用 |
| pdf2htmlEX 体积大 | 作为可选组件，按需启用 |
| 读 ACL 使搜索 SQL 复杂化 | `readableScopeFilter` 集中生成 where，搜索服务原生 SQL 注入参数化 |
| 权限变更 JWT 不及时 | 编辑授权实时查库 + 短缓存；读权限靠查询过滤不依赖 JWT |
| 存量 PDF 无全文 | 迁移脚本批量重跑 pdf-parse 回填 content |

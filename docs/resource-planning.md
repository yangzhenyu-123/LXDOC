# 部署资源规划

本文基于 [docker-compose.yml](../docker-compose.yml) 的资源限制与各服务实际负载特征，给出 LXDOC 部署的硬件选型建议、磁盘预估与运维补充配置。

## 服务资源清单

| 服务 | 镜像 | mem_limit | cpus | 用途 | 是否对外 |
|------|------|-----------|------|------|---------|
| postgres | postgres:16-alpine | 1g | 2 | 元数据/用户/审计/文档索引存储 | 否（仅 internal） |
| backend | lxdoc-backend | 2g | 2 | NestJS API + 文档解析 + LLM 调用 + LibreOffice/soffice 转换 | 经 nginx 反代 |
| onlyoffice | documentserver:8.2 | 2g | 2 | docx/odt 原格式在线编辑 | 经 nginx 反代 |
| pdf2html | lxdoc-pdf2html | 1g | 1 | PDF→版式 HTML sidecar | 否（仅内部） |
| docling | docling-serve:cpu-latest | 4g | 2 | 统一文档解析（PDF 图片/表格/OCR）sidecar，可选 | 否（仅 internal） |
| frontend | lxdoc-frontend | 512m | 1 | nginx 静态站 + 反代 | 8080 对外 |

> 不含 docling 时容器资源限制总和约 **6.5 GB**；启用 docling（`DOCLING_ENABLED=true`）后增至 **10.5 GB**。docling 为可选 sidecar，不启用时上传回退本地 pandoc/pdf-parse。
>
> 起步线：不启用 docling **8 GB**；启用 docling **12 GB**。

## 推荐配置

### 最低可启动（小团队 / PoC）

- 内存：约 **6.5 GB**（不含 docling，5 容器限制之和）+ 宿主机系统 ~1 GB
- CPU：**2 核**（所有容器共享，调度紧张）
- 磁盘：**20 GB**（系统 + 镜像约 5 GB + 上传文档 + Postgres 数据 + OnlyOffice 缓存/字体）
- 实际可用：勉强，OnlyOffice 与 soffice 并发转换时易 OOM/卡顿
- docling：保持 `DOCLING_ENABLED=false`，上传走 pandoc/pdf-parse

### 推荐生产（中等团队，~50 人并发）

- 内存：**12–16 GB**（启用 docling 后）
- CPU：**4 核**
- 磁盘：**80–120 GB** SSD（docling 模型缓存约 2 GB）
- 说明：OnlyOffice 编辑 + backend 的 soffice PDF→docx 转换是内存大户，2g 上限偏紧，建议监控后按需上调到 3g；启用 docling 后 PDF 能提取图片/表格，AI 总结质量显著提升

### 高负载（百人级并发 / 大量 PDF）

- 内存：**16 GB+**
- CPU：**8 核**
- 磁盘：**200 GB+** SSD
- 建议：OnlyOffice 横向扩展或独立部署；Postgres 单独实例

## 关键资源消耗点

1. **OnlyOffice Document Server**（最重）
   - 官方建议最低 2 核 / 4 GB，当前配置 2g 偏保守
   - 同时编辑多个 docx 时内存上涨明显，是 OOM 高风险点
   - 字体缓存、文档转换缓存占磁盘（`onlyoffice-cache` volume）

2. **backend 的 LibreOffice（soffice）**
   - PDF→docx 转换单次峰值可达数百 MB
   - 与 Node 进程共用 2g 上限，并发转换易触顶
   - 无并发队列限制时可能 fork 多个 soffice 进程

3. **pdf2html sidecar**
   - 大 PDF（>50 MB）转换吃 CPU 和内存
   - 1g / 1cpu 仅够串行处理中小 PDF

4. **Postgres**
   - 文档全文搜索（含 snippet）、审计日志增长快
   - 1g 够用，但审计表需定期清理/归档，否则磁盘膨胀

5. **uploads 目录**
   - 挂载到宿主机 `./uploads`，无上限，需外部监控磁盘水位

## 磁盘占用预估

| 项 | 大小 |
|----|------|
| 5 个镜像合计 | ~4–5 GB |
| Postgres 初始数据 | <100 MB |
| OnlyOffice 字体+缓存 | 1–2 GB |
| uploads（按用户使用） | 不定，建议按 1 GB / 100 文档预估 |
| 日志（容器 json-driver） | 默认无轮转上限，需配置 `logging.options.max-size` |

## 网络 / 端口

- 仅 `frontend:8080` 对外暴露
- postgres / backend / onlyoffice / pdf2html 均不直接对外（internal 网络 + expose）
- 仅需开放 **8080**（或反代后 80/443），最小攻击面

## 运维补充配置

当前 compose 未设置以下项，生产建议补上。

### 1. 日志轮转（防磁盘打爆）

为各服务追加：

```yaml
backend:
  logging:
    driver: json-file
    options:
      max-size: "50m"
      max-file: "5"
```

### 2. uploads 磁盘水位监控

宿主机挂载点 `./uploads` 需告警，建议阈值 80%。

### 3. OnlyOffice 内存上调

观察实际负载后，建议 `mem_limit: 3g`（当前 2g 在多文档并发编辑时偏紧）。

### 4. 审计日志归档

Postgres `audit_log` 表增长快，需定期清理/导出：

```sql
-- 保留最近 90 天审计日志
DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days';
```

可配 cron 或 pg_cron 定期执行。

## 一句话结论

- **最小可跑**：4 核 / 8 GB / 50 GB SSD
- **稳妥生产**：4 核 / 12 GB / 100 GB SSD，重点盯 OnlyOffice 和 soffice 的内存峰值
- 当前 compose 资源限制总和 6.5 GB，加上宿主机开销，**8 GB 是实际起步线**

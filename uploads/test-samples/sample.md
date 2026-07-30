# LXDOC 测试样本 Markdown

这是一个用于 LXDOC 企业知识库端到端验证的中文 Markdown 样本文件。

## 简介

LXDOC 是一个轻量、可私有化部署的企业知识库系统，支持以下特性：

- 多格式文档入库（Markdown / TXT / DOCX / ODT / PDF）
- 三层顶层分类树：技术文档、解决方案、Bug 分析报告
- 基于 Vditor 的 Markdown 在线编辑器
- 全文检索（PostgreSQL `pg_trgm` + 中文分词）
- PDF / DOCX / ODT 在线预览

## 技术栈

后端使用 NestJS + TypeORM + PostgreSQL；前端使用 Vue3 + Vite + Element Plus；通过 Docker Compose 单机部署。

## 内嵌图片示例

下面是一个本地图片引用（图片用占位说明，部署环境可放置真实图片）：

![LXDOC 架构示意图](./images/architecture-placeholder.png)

> 注：占位图片路径为 `./images/architecture-placeholder.png`，实际部署时请在同目录放置该图片，或上传后系统会自动将图片抽取到 `uploads/images/<docId>/` 目录。

## 代码块示例

```typescript
// 后端健康检查示例
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
```

## 关键词高亮测试

请在搜索框输入「知识库」「分类树」「Pandoc」等关键词，验证搜索结果片段高亮显示是否正常。

## 版本历史

- v1：初始版本，仅包含基础结构
- v2：补充技术栈与代码示例
- v3：增加图片引用说明

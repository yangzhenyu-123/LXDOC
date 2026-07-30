# LXDOC 测试样本文件说明

本目录用于存放 LXDOC 企业知识库端到端验证所需的 5 种格式测试样本。

## 已生成的样本（CI 环境可直接生成）

| 文件名 | 说明 |
|--------|------|
| `sample.md` | 中文 Markdown 样本，含标题、列表、代码块、本地图片引用（占位说明） |
| `sample.txt` | 纯文本样本，用于验证 TXT 直接读取入库 |

## 需在部署环境手动生成的样本（CI 环境无 pandoc / LaTeX）

> CI 环境未安装 `pandoc` 二进制，也无 LaTeX，因此以下格式需在部署环境生成。

### 方式一：使用 pandoc 从 sample.md 生成

```bash
cd uploads/test-samples

# 生成 DOCX（需 pandoc）
pandoc sample.md -o sample.docx

# 生成 ODT（需 pandoc）
pandoc sample.md -o sample.odt

# 生成 PDF（需 pandoc + LaTeX，例如 texlive-xetex）
# 若无 LaTeX 可改用 wkhtmltopdf 或浏览器另存为 PDF
pandoc sample.md -o sample.pdf --pdf-engine=xelatex -V CJKmainfont="Noto Sans CJK SC"
```

### 方式二：手动放置任意对应格式文件

如不便用 pandoc 生成，可直接将任意符合格式的文件重命名为：

- `sample.docx` —— 任意 Word 文档（建议含一张内嵌图片，便于验证图片抽取）
- `sample.odt` —— 任意 ODT 文档
- `sample.pdf` —— 任意 PDF 文档（建议大于 1 页，便于验证翻页预览）

## 验证清单

将 5 种格式样本准备齐全后，可在 LXDOC 中执行端到端验证：

1. 上传 `sample.md` → 验证正文被读取、标题为文件名、可在编辑器修改
2. 上传 `sample.txt` → 验证纯文本读取
3. 上传 `sample.docx` → 验证 Pandoc 转 Markdown、图片被抽取到 `uploads/images/<docId>/`
4. 上传 `sample.odt` → 验证与 docx 一致的转换流程
5. 上传 `sample.pdf` → 验证页数与首页标题提取、正文留空、PDF 在线预览

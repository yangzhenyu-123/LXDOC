/**
 * docling-serve 解析服务配置
 *
 * docling-serve 是 IBM docling 的 HTTP 服务封装，统一解析 docx/odt/pdf/pptx 等，
 * 支持 PDF 图片/表格/版式/OCR。作为主解析器使用，失败时回退到 pandoc/pdf-parse。
 *
 * 部署：docker-compose 内置 docling sidecar（docling-serve CPU 镜像），
 * 后端通过 DOCLING_URL 调用 /v1/convert/file。
 */
import { getOverrideBool } from '../system/settings-overrides';

export const doclingConfig = {
  // 总开关：false 时全格式走原解析器（pandoc/pdf-parse）。支持在线修改。
  get enabled(): boolean {
    return getOverrideBool('docling.enabled', process.env.DOCLING_ENABLED === 'true');
  },
  // docling-serve 基地址（compose 内网默认 http://docling:5001）
  baseUrl: process.env.DOCLING_URL ?? 'http://docling:5001',
  // API Key（内网部署可留空；docling-serve 设置 DOCLING_SERVE_API_KEY 时需对应）
  apiKey: process.env.DOCLING_API_KEY ?? '',
  // 是否启用 OCR（扫描件/图片型 PDF 才需要，CPU 模式下显著增加耗时与内存）。支持在线修改。
  get doOcr(): boolean {
    return getOverrideBool('docling.doOcr', process.env.DOCLING_DO_OCR === 'true');
  },
  // 单次转换超时（毫秒），大 PDF/OCR 场景默认 3 分钟
  timeout: Number(process.env.DOCLING_TIMEOUT ?? '180000') || 180000,
};

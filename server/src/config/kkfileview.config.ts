/**
 * kkFileView 统一预览服务集成配置
 * - enabled：是否启用 kkFileView 统一预览（false 时前端回退 pandoc/pdf2htmlEX）
 * - internalUrl：后端/容器内访问 kkFileView 的地址（compose 内网服务名）
 * - publicUrl：浏览器访问 kkFileView 的地址（通常经 nginx 同源反代 /kkview）
 *
 * 部署形态：
 *   1. kkFileView 容器与后端同 docker network，internalUrl=http://kkfileview:8012
 *   2. 浏览器经 nginx 反代 /kkview/ → kkfileview:8012，publicUrl=/kkview（同源，避免 CORS）
 *   3. 本地开发：internalUrl 与 publicUrl 均为 http://localhost:8012（端口映射到宿主机）
 *
 * 预览接入：后端 GET /api/documents/:id/kkview 返回拼好的 kkFileView 预览 URL
 *   （文件下载 URL 走 /api/files/:docId/original?token=，base64 编码后作为 ?url= 参数）
 */
import { getOverrideBool } from '../system/settings-overrides';

export const kkfileviewConfig = {
  get enabled(): boolean {
    return getOverrideBool('kkfileview.enabled', (process.env.KKFILEVIEW_ENABLED ?? 'true').toLowerCase() === 'true');
  },
  internalUrl:
    process.env.KKFILEVIEW_URL ?? 'http://kkfileview:8012',
  publicUrl:
    process.env.KKFILEVIEW_PUBLIC_URL ?? '/kkview',
};

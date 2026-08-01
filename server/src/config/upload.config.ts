/**
 * 上传文件存储配置
 * 优先从环境变量 UPLOAD_DIR 读取，默认 /app/uploads
 * 开发时本地可在 .env 中设为 ./uploads
 */
export function getUploadDir(): string {
  return process.env.UPLOAD_DIR ?? '/app/uploads';
}

import { getOverrideNumber } from '../system/settings-overrides';

/**
 * 上传相关配置常量
 * maxDocFileSize/maxImageFileSize 支持在线修改（DB 以 MB 为单位存储，getter 换算为字节）。
 */
export const uploadConfig = {
  // 上传根目录
  uploadDir: process.env.UPLOAD_DIR ?? '/app/uploads',
  // 允许的文档扩展名白名单（主文档格式，含 kkFileView 支持的 office 类 + 版式 + 模板）
  allowedDocExtensions: [
    '.md',
    '.markdown',
    '.txt',
    '.docx',
    '.odt',
    '.pdf',
    // office 类（正文不可解析，仅 kkFileView 预览）
    '.doc',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.csv',
    '.tsv',
    '.wps',
    '.dps',
    '.et',
    '.ett',
    '.wpt',
    '.ods',
    '.odp',
    '.ott',
    '.fodt',
    '.fods',
    // 版式/富文本
    '.ofd',
    '.rtf',
    // Office 宏/模板
    '.xlsm',
    '.dotm',
    '.xlt',
    '.xltm',
    '.dot',
    '.xlam',
    '.dotx',
    '.xla',
    '.pptm',
    // OpenOffice 模板
    '.ots',
    '.otp',
    '.six',
  ],
  // 附件允许的扩展名（覆盖 kkFileView 5.0.1 支持的全部格式）
  // 附件不限制正文解析，仅落盘 + kkFileView 预览
  allowedAttachmentExtensions: [
    // 压缩包
    '.zip', '.rar', '.jar', '.tar', '.gz', '.7z',
    // 源码/文本
    '.xml', '.java', '.js', '.css', '.py', '.php', '.c', '.cpp', '.h', '.hpp',
    '.go', '.rs', '.rb', '.sh', '.bash', '.json', '.yaml', '.yml', '.toml',
    '.sql', '.md', '.markdown', '.txt', '.log',
    // 图片（kkFileView 支持的全格式）
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.jfif', '.webp',
    '.heic', '.heif', '.tif', '.tiff', '.tga', '.svg', '.wmf', '.emf',
    // Photoshop/矢量
    '.psd', '.eps',
    // office 类（也可作为附件）
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.tsv',
    '.wps', '.dps', '.et', '.ett', '.wpt',
    '.odt', '.ods', '.odp', '.ott', '.fodt', '.fods', '.pdf',
    // 版式/富文本
    '.ofd', '.rtf',
    // Office 宏/模板
    '.xlsm', '.dotm', '.xlt', '.xltm', '.dot', '.xlam', '.dotx', '.xla', '.pptm',
    '.ots', '.otp', '.six', '.pages',
    // Visio 流程图
    '.vsd', '.vsdx',
    // CAD 图纸
    '.dwg', '.dxf', '.dwf', '.igs', '.dwt', '.dng', '.dwfx', '.cf2', '.plt',
    // 3D 模型
    '.obj', '.3ds', '.stl', '.ply', '.gltf', '.glb', '.off', '.3dm',
    '.fbx', '.dae', '.wrl', '.3mf', '.ifc', '.brep', '.step', '.iges',
    '.fcstd', '.bim',
    // 模型/绘图/工作流
    '.xmind', '.bpmn', '.drawio',
    // 邮件
    '.eml', '.msg',
    // 电子书
    '.epub',
    // 医疗影像
    '.dcm',
    // 财务报告
    '.xbrl',
    // 音频
    '.mp3', '.wav',
    // 视频
    '.mp4', '.flv', '.avi', '.mov', '.wmv', '.mkv', '.3gp', '.rm',
  ],
  // 允许的图片 MIME 白名单
  allowedImageMimes: [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ],
  // 允许的图片扩展名白名单（必须与 MIME 一致，防止 svg/html 伪装成图片落盘触发 XSS）
  allowedImageExtensions: [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
  ],
  // 上传文件大小上限（字节）：文档默认 50MB，图片默认 10MB。支持在线以 MB 为单位修改。
  get maxDocFileSize(): number {
    const mb = getOverrideNumber('upload.maxDocFileSizeMB', Number(process.env.UPLOAD_MAX_DOC_MB ?? '50') || 50);
    return Math.round(mb * 1024 * 1024);
  },
  get maxImageFileSize(): number {
    const mb = getOverrideNumber('upload.maxImageFileSizeMB', Number(process.env.UPLOAD_MAX_IMAGE_MB ?? '10') || 10);
    return Math.round(mb * 1024 * 1024);
  },
};

/**
 * 上传文件存储配置
 * 优先从环境变量 UPLOAD_DIR 读取，默认 /app/uploads
 * 开发时本地可在 .env 中设为 ./uploads
 */
export function getUploadDir(): string {
  return process.env.UPLOAD_DIR ?? '/app/uploads';
}

/**
 * 上传相关配置常量
 */
export const uploadConfig = {
  // 上传根目录
  uploadDir: process.env.UPLOAD_DIR ?? '/app/uploads',
  // 允许的文档扩展名白名单
  allowedDocExtensions: [
    '.md',
    '.markdown',
    '.txt',
    '.docx',
    '.odt',
    '.pdf',
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
  // 上传文件大小上限（字节）：文档 50MB，图片 10MB
  maxDocFileSize: 50 * 1024 * 1024,
  maxImageFileSize: 10 * 1024 * 1024,
};

/**
 * 认证相关配置
 * - jwtSecret：JWT 签名密钥，生产环境务必通过 JWT_SECRET 环境变量更换为强随机值
 * - jwtAccessExpires：access token 有效期，默认 15 分钟
 * - jwtRefreshExpires：refresh token 有效期，默认 7 天
 * - allowSignup：是否开放自注册，默认关闭（false）
 * - fileTokenExpires：静态文件签名 token 有效期，默认 10 分钟
 *   用于 /api/files/:docId/...?token= 形式访问原文件与图片（<img src> 无法带 Authorization 头）
 */
export const authConfig = {
  jwtSecret: process.env.JWT_SECRET ?? 'lxdoc-dev-secret-change-me',
  jwtAccessExpires: process.env.JWT_ACCESS_EXPIRES ?? '15m',
  jwtRefreshExpires: process.env.JWT_REFRESH_EXPIRES ?? '7d',
  fileTokenExpires: process.env.FILE_TOKEN_EXPIRES ?? '10m',
  allowSignup:
    (process.env.ALLOW_SIGNUP ?? 'false').toLowerCase() === 'true',
};

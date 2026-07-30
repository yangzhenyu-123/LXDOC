/**
 * 认证相关配置
 * - jwtSecret：JWT 签名密钥，生产环境务必通过 JWT_SECRET 环境变量更换为强随机值
 * - jwtAccessExpires：access token 有效期，默认 15 分钟
 * - jwtRefreshExpires：refresh token 有效期，默认 7 天
 * - allowSignup：是否开放自注册，默认关闭（false）
 */
export const authConfig = {
  jwtSecret: process.env.JWT_SECRET ?? 'lxdoc-dev-secret-change-me',
  jwtAccessExpires: process.env.JWT_ACCESS_EXPIRES ?? '15m',
  jwtRefreshExpires: process.env.JWT_REFRESH_EXPIRES ?? '7d',
  allowSignup:
    (process.env.ALLOW_SIGNUP ?? 'false').toLowerCase() === 'true',
};

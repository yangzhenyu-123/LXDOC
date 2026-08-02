/**
 * 认证相关配置
 * - jwtSecret：JWT 签名密钥，生产环境务必通过 JWT_SECRET 环境变量更换为强随机值
 * - jwtAccessExpires：access token 有效期，默认 15 分钟
 * - jwtRefreshExpires：refresh token 有效期，默认 7 天
 * - allowSignup：是否开放自注册，默认关闭（false）。支持在线修改。
 * - fileTokenExpires：静态文件签名 token 有效期，默认 10 分钟
 *   用于 /api/files/:docId/...?token= 形式访问原文件与图片（<img src> 无法带 Authorization 头）
 */
import { getOverrideBool } from '../system/settings-overrides';

/** 不安全的默认密钥，生产环境禁止使用 */
const INSECURE_DEFAULT_SECRET = 'lxdoc-dev-secret-change-me';

/** 是否为生产环境（NODE_ENV=production） */
const isProduction = process.env.NODE_ENV === 'production';

/** 用户配置的 JWT secret，未配置时回退到不安全默认值（仅开发可用） */
const configuredJwtSecret = process.env.JWT_SECRET ?? INSECURE_DEFAULT_SECRET;

/**
 * 生产环境启动校验：若仍在使用不安全默认密钥，直接抛错拒绝启动。
 * 防止线上用默认 secret 导致攻击者可伪造任意 access token（含 admin role）登录。
 */
if (isProduction && configuredJwtSecret === INSECURE_DEFAULT_SECRET) {
  // 直接抛错让进程退出，必须在 .env / 环境变量中设置 JWT_SECRET
  throw new Error(
    '[auth] 生产环境禁止使用默认 JWT_SECRET，请通过环境变量设置强随机值（建议 >= 32 字节）',
  );
}

export const authConfig = {
  jwtSecret: configuredJwtSecret,
  jwtAccessExpires: process.env.JWT_ACCESS_EXPIRES ?? '15m',
  jwtRefreshExpires: process.env.JWT_REFRESH_EXPIRES ?? '7d',
  fileTokenExpires: process.env.FILE_TOKEN_EXPIRES ?? '10m',
  get allowSignup(): boolean {
    return getOverrideBool('auth.allowSignup', (process.env.ALLOW_SIGNUP ?? 'false').toLowerCase() === 'true');
  },
};

/**
 * H8 修复：access/refresh token 改 httpOnly cookie 存储
 *
 * cookie 命名（与前端约定，前端不再读写，仅由后端 Set-Cookie）：
 * - lxdoc_access_token：access token，httpOnly + SameSite=Lax + Secure(生产)
 * - lxdoc_refresh_token：refresh token，httpOnly + SameSite=Lax + Secure(生产) + 7d maxAge
 *
 * 前端 axios 需 withCredentials: true 才会携带 cookie；CORS 已在 main.ts 配置 credentials: true。
 */
export const ACCESS_TOKEN_COOKIE = 'lxdoc_access_token';
export const REFRESH_TOKEN_COOKIE = 'lxdoc_refresh_token';

/** 是否生产环境（用于决定 cookie 的 Secure 标志） */
const isProdCookie = process.env.NODE_ENV === 'production';

/**
 * 解析 expires 字符串（如 '15m'、'7d'、'2h'）为毫秒数
 * 用于同步设置 cookie maxAge 与 JWT 实际有效期
 */
function parseExpiresToMs(expires: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(expires.trim());
  if (!m) return 15 * 60 * 1000; // 回退 15 分钟
  const n = Number(m[1]);
  switch (m[2]) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
    case 'd':
      return n * 24 * 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}

/** access cookie 选项（httpOnly，无 maxAge → 会话 cookie，浏览器关闭即清，token 自身 15min 过期） */
export const accessTokenCookieOptions = {
  httpOnly: true,
  secure: isProdCookie,
  sameSite: 'lax' as const,
  path: '/',
};

/** refresh cookie 选项（httpOnly + 7d maxAge，跨浏览器重启保持登录态） */
export const refreshTokenCookieOptions = {
  httpOnly: true,
  secure: isProdCookie,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: parseExpiresToMs(process.env.JWT_REFRESH_EXPIRES ?? '7d'),
};

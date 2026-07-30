/**
 * OnlyOffice Document Server 集成配置
 * - onlyofficeUrl：OnlyOffice Document Server 内部地址，后端用于拼装 fileUrl/callbackUrl
 * - onlyofficePublicUrl：浏览器可访问的 OnlyOffice 地址（前端 api.js 加载来源），通常为反代路径
 * - backendPublicUrl：OnlyOffice 容器回调后端时使用的地址（需 OnlyOffice 容器能访问）
 * - jwtSecret：与 OnlyOffice 服务共享的 JWT 密钥，用于签发前端 config 与校验回调
 * - fileTokenExpires：fileUrl 签名 token 有效期（默认 10m，与 authConfig 对齐）
 *
 * 部署形态：
 *   1. OnlyOffice 容器与后端容器同 docker network，onlyofficeUrl=http://onlyoffice
 *   2. 浏览器访问 OnlyOffice 经后端反代 /onlyoffice/ → onlyoffice:80
 *      此时 onlyofficePublicUrl 设为 /onlyoffice（同源，无需 CORS）
 *   3. OnlyOffice 容器回调后端走 http://backend:3000/api/...
 *      backendPublicUrl=http://backend:3000
 */
/** 不安全的默认密钥，生产环境禁止使用 */
const INSECURE_DEFAULT_OO_SECRET = 'lxdoc-onlyoffice-dev-secret';

/** 是否为生产环境 */
const isProduction = process.env.NODE_ENV === 'production';

/** 配置的 OnlyOffice jwt secret，未配置时回退到主 JWT_SECRET，再回退到不安全默认值（仅开发） */
const configuredOoSecret =
  process.env.ONLYOFFICE_JWT_SECRET ?? process.env.JWT_SECRET ?? INSECURE_DEFAULT_OO_SECRET;

/**
 * 生产环境启动校验：OnlyOffice 回调接口为 @Public，仅靠此密钥校验回调 JWT。
 * 若仍用不安全默认值，攻击者可伪造回调 JWT 覆盖任意文档内容，故生产环境必须设置。
 */
if (isProduction && configuredOoSecret === INSECURE_DEFAULT_OO_SECRET) {
  throw new Error(
    '[onlyoffice] 生产环境禁止使用默认 ONLYOFFICE_JWT_SECRET，请通过环境变量设置（可复用 JWT_SECRET 或单独设置 ONLYOFFICE_JWT_SECRET）',
  );
}

export const onlyofficeConfig = {
  onlyofficeUrl:
    process.env.ONLYOFFICE_URL ?? 'http://onlyoffice',
  onlyofficePublicUrl:
    process.env.ONLYOFFICE_PUBLIC_URL ?? process.env.VITE_ONLYOFFICE_URL ?? '/onlyoffice',
  backendPublicUrl:
    process.env.BACKEND_PUBLIC_URL ?? 'http://localhost:3000',
  jwtSecret: configuredOoSecret,
  // 是否启用 OnlyOffice（false 时前端走 mammoth 降级）
  enabled:
    (process.env.ONLYOFFICE_ENABLED ?? 'true').toLowerCase() === 'true',
};

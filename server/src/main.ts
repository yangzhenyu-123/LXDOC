import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // 安全响应头：CSP、X-Content-Type-Options、X-Frame-Options、HSTS 等
  // 仅对后端 API 生效（nginx 侧已对静态前端资源补头，但 /api 反代路径未透传）
  // CSP 适度放宽：OnlyOffice 编辑器需经 /onlyoffice 同源 iframe 加载，图片走鉴权同源 URL；
  // 禁用 inline script 风险由 helmet 默认规则覆盖，这里仅放开 frame-ancestors 与图片源
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // API 响应本身不需执行脚本；frame-ancestors 允许同源以便 OnlyOffice iframe 场景
          defaultSrc: ["'self'"],
          frameAncestors: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          // 仅 Office 预览/编辑走同源 /onlyoffice，无需外部源
          connectSrc: ["'self'"],
        },
      },
      // OnlyOffice 编辑器需在 iframe 中加载同源页面，保持 SAMEORIGIN
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // 全局 ValidationPipe：自动对 DTO 进行 class-validator 校验
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // 全局前缀 /api，但 health 路由除外（在 controller 单独用 exclude 配置）
  app.setGlobalPrefix('api', {
    exclude: ['health'],
  });

  // 静态文件不再裸暴露：原文件 / 图片统一走 /api/files/:docId/...?token= 鉴权接口
  // （FilesController 负责签名校验后 res.sendFile）

  // CORS：默认不开启跨域（生产经 nginx 同源反代，无需跨域）；
  // 可通过 CORS_ORIGINS 环境变量配置允许的来源白名单（逗号分隔），如 "https://lxdoc.example.com,http://localhost:5173"
  const corsOrigins = process.env.CORS_ORIGINS;
  if (corsOrigins) {
    app.enableCors({
      origin: corsOrigins
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      credentials: true,
    });
  }

  // API 调试文档（Swagger UI）：
  // - 开发环境（NODE_ENV !== production）默认开启
  // - 生产环境默认关闭，需显式 ENABLE_API_DOCS=true 才开启，避免接口结构泄露
  const enableDocs =
    process.env.ENABLE_API_DOCS === 'true' ||
    (process.env.ENABLE_API_DOCS === undefined &&
      process.env.NODE_ENV !== 'production');
  if (enableDocs) {
    // Swagger UI（/api/docs）依赖内联脚本/样式，对该路径覆盖 CSP 为宽松策略；
    // 其余路径仍保持上方 helmet 的严格 CSP。setHeader 覆盖整个 CSP 头值。
    app.use('/api/docs', (req, res, next) => {
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "font-src 'self' data:",
          "connect-src 'self'",
        ].join('; '),
      );
      next();
    });
    const config = new DocumentBuilder()
      .setTitle('LXDOC API')
      .setDescription(
        'LXDOC 企业知识库 API 调试文档。\n\n' +
          '鉴权方式：除 @Public 接口外，均需在右上角 Authorize 填入 ' +
          '`Bearer <accessToken>`（登录 /api/auth/login 获取）。',
      )
      .setVersion('0.1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'Authorization',
          in: 'header',
        },
        'access-token',
      )
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.log('API 调试文档已启用：/api/docs');
  } else {
    logger.log('API 调试文档已关闭（生产环境需 ENABLE_API_DOCS=true 开启）');
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`LXDOC 后端服务已启动，监听端口 ${port}`);
}
bootstrap();

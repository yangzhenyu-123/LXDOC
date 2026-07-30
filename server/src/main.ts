import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
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

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`LXDOC 后端服务已启动，监听端口 ${port}`);
}
bootstrap();

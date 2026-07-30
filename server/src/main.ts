import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

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

  // 启用 CORS，方便本地开发前后端联调
  app.enableCors();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`LXDOC 后端服务已启动，监听端口 ${port}`);
}
bootstrap();

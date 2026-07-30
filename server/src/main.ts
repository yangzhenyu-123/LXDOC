import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { getUploadDir } from './config/upload.config';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // 使用 NestExpressApplication 以支持 useStaticAssets 静态文件服务
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

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

  // 启用静态文件服务：/uploads/* → ${UPLOAD_DIR}
  // 用于访问已上传的原始文件与图片
  const uploadDir = getUploadDir();
  app.useStaticAssets(uploadDir, { prefix: '/uploads/' });

  // 启用 CORS，方便本地开发前后端联调
  app.enableCors();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`LXDOC 后端服务已启动，监听端口 ${port}`);
  logger.log(`静态资源前缀 /uploads → ${uploadDir}`);
}
bootstrap();

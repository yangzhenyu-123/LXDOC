import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemController } from './system.controller';
import { SystemSetting } from './system-setting.entity';
import { SystemSettingsService } from './system-settings.service';

/**
 * 系统配置模块
 * - GET  /api/system/config：返回各服务运行时配置（可改项 + 只读项），敏感值脱敏
 * - PUT  /api/system/config：批量修改可改项（仅 admin），立即生效无需重启
 */
@Module({
  imports: [TypeOrmModule.forFeature([SystemSetting])],
  controllers: [SystemController],
  providers: [SystemSettingsService],
  exports: [SystemSettingsService],
})
export class SystemModule {}

import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { llmConfig } from '../config/llm.config';
import { onlyofficeConfig } from '../config/onlyoffice.config';
import { kkfileviewConfig } from '../config/kkfileview.config';
import { doclingConfig } from '../config/docling.config';
import { authConfig } from '../config/auth.config';
import { uploadConfig } from '../config/upload.config';
import { SystemSettingsService } from './system-settings.service';

/**
 * 单个配置项（key + value）
 * value 可为 null（表示清空）；string 类型用 IsString + IsOptional 容纳 null
 */
class ConfigItemDto {
  @IsString()
  key!: string;

  @IsString()
  @IsOptional()
  value: string | null;
}

/**
 * 更新设置的请求体
 * items: 要修改的键值对。敏感项传 "******" 视为不修改（跳过）。
 * 注意：全局 ValidationPipe 启用 whitelist + forbidNonWhitelisted，
 *       所有字段必须加 class-validator 装饰器，否则请求被 400 拒绝。
 */
class UpdateConfigDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConfigItemDto)
  items: ConfigItemDto[];
}

/**
 * 系统配置控制器（仅 admin）
 * - GET /api/system/config：返回运行时配置（可改项 + 只读项），敏感值脱敏
 * - PUT /api/system/config：批量修改可改项，立即生效无需重启
 *
 * 不可改项（jwtSecret、服务 URL、端口等）仅展示，修改需编辑 .env 后重启容器。
 */
@ApiTags('系统配置 System')
@ApiBearerAuth('access-token')
@Roles(UserRole.ADMIN)
@Controller('system')
export class SystemController {
  constructor(private readonly settingsService: SystemSettingsService) {}

  @ApiOperation({ summary: '获取系统配置（仅 admin，脱敏）' })
  @Get('config')
  getConfig() {
    return {
      llm: {
        enabled: llmConfig.enabled,
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
        embedBaseUrl: llmConfig.embedBaseUrl,
        embedModel: llmConfig.embedModel || '',
        embedDimensions: llmConfig.embedDimensions || 0,
        timeout: llmConfig.timeout,
        maxRetries: llmConfig.maxRetries,
        summaryMaxChars: llmConfig.summaryMaxChars,
      },
      onlyoffice: {
        enabled: onlyofficeConfig.enabled,
        onlyofficeUrl: onlyofficeConfig.onlyofficeUrl,
        onlyofficePublicUrl: onlyofficeConfig.onlyofficePublicUrl,
        backendPublicUrl: onlyofficeConfig.backendPublicUrl,
        // jwtSecret 不返回（敏感）
      },
      kkfileview: {
        enabled: kkfileviewConfig.enabled,
        internalUrl: kkfileviewConfig.internalUrl,
        publicUrl: kkfileviewConfig.publicUrl,
      },
      docling: {
        enabled: doclingConfig.enabled,
        baseUrl: doclingConfig.baseUrl,
        // apiKey 不返回（敏感）
        doOcr: doclingConfig.doOcr,
        timeout: doclingConfig.timeout,
      },
      auth: {
        jwtAccessExpires: authConfig.jwtAccessExpires,
        jwtRefreshExpires: authConfig.jwtRefreshExpires,
        fileTokenExpires: authConfig.fileTokenExpires,
        allowSignup: authConfig.allowSignup,
      },
      upload: {
        uploadDir: uploadConfig.uploadDir,
        maxDocFileSizeMB: Math.round(uploadConfig.maxDocFileSize / 1024 / 1024),
        maxImageFileSizeMB: Math.round(
          uploadConfig.maxImageFileSize / 1024 / 1024,
        ),
        allowedDocExtensions: uploadConfig.allowedDocExtensions,
        allowedImageExtensions: uploadConfig.allowedImageExtensions,
      },
    };
  }

  @ApiOperation({ summary: '获取可在线修改的设置项清单（含分组/类型/脱敏值）' })
  @Get('settings')
  async getEditableSettings() {
    return this.settingsService.getAllForDisplay();
  }

  @ApiOperation({ summary: '批量更新可在线修改的设置项（仅 admin，立即生效）' })
  @Put('config')
  async updateConfig(
    @Body() dto: UpdateConfigDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.settingsService.updateMany(dto.items ?? [], user.id);
  }
}

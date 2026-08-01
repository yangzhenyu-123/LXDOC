import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/user.entity';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { LlmConfigService } from './llm-config.service';

/** 用户自配 LLM 配置 DTO */
class UpdateMyLlmConfigDto {
  @IsOptional()
  @IsString()
  baseUrl?: string | null;

  @IsOptional()
  @IsString()
  apiKey?: string | null;

  @IsOptional()
  @IsString()
  model?: string | null;

  @IsOptional()
  @IsBoolean()
  enableThinking?: boolean;

  @IsOptional()
  @IsString()
  actAsUserId?: string | null;
}

/**
 * LLM 配置管理控制器
 *
 * 新架构（用户级 LLM 配置）：
 * - GET    /api/llm/my-config              获取自己的 LLM 配置（apiKey 脱敏）
 * - PUT    /api/llm/my-config              更新自己的 LLM 配置
 *
 * admin:
 * - GET    /api/llm/users-overview         所有用户的 LLM 配置概览（apiKey 脱敏）
 * - GET    /api/llm/act-as-candidates      可被代理的用户列表
 */
@ApiTags('LLM 配置 LlmConfig')
@ApiBearerAuth('access-token')
@Controller('llm')
export class LlmConfigController {
  constructor(private readonly service: LlmConfigService) {}

  // ---------- 用户自配 LLM（新架构） ----------

  @ApiOperation({ summary: '获取当前用户的 LLM 配置（apiKey 脱敏）' })
  @Get('my-config')
  getMyLlmConfig(@CurrentUser() user: AuthUser) {
    return this.service.getMyLlmConfig(user.id);
  }

  @ApiOperation({ summary: '更新当前用户的 LLM 配置' })
  @Put('my-config')
  updateMyLlmConfig(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateMyLlmConfigDto,
  ) {
    return this.service.updateMyLlmConfig(user.id, body);
  }

  // ---------- admin: 用户 LLM 配置管理 ----------

  @ApiOperation({ summary: '所有用户的 LLM 配置概览（admin，apiKey 脱敏）' })
  @Roles(UserRole.ADMIN)
  @Get('users-overview')
  getAllUsersLlmOverview() {
    return this.service.getAllUsersLlmOverview();
  }

  @ApiOperation({ summary: '可被代理的用户列表（admin）' })
  @Roles(UserRole.ADMIN)
  @Get('act-as-candidates')
  getActAsCandidates(@CurrentUser() user: AuthUser) {
    return this.service.getActAsCandidates(user.id);
  }
}

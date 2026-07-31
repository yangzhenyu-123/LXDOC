import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { LlmService } from './llm.service';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/user.entity';
import { llmConfig } from '../config/llm.config';

/**
 * LLM 健康检查控制器
 * 全局前缀 /api 由 main.ts 设置
 *
 * 路由：
 * - GET /api/llm/health   返回 LLM 各 Provider 就绪状态（仅 admin）
 *
 * 设计：仅暴露只读健康检查；chat/embed 等业务能力由各业务模块通过 LlmService 直接调用，
 * 不在此处暴露通用对话接口（避免权限与滥用风险）。
 */
@ApiTags('LLM')
@ApiBearerAuth('access-token')
@Controller('llm')
export class LlmController {
  constructor(private readonly llm: LlmService) {}

  @ApiOperation({ summary: 'LLM 健康检查（仅 admin）' })
  @Roles(UserRole.ADMIN)
  @Get('health')
  health() {
    const status = this.llm.health();
    return {
      ...status,
      // 暴露关键配置（脱敏：apiKey 不返回）
      config: {
        enabled: llmConfig.enabled,
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
        embedModel: llmConfig.embedModel || null,
        embedDimensions: llmConfig.embedDimensions || null,
        timeout: llmConfig.timeout,
      },
    };
  }
}

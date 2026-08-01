import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LLM_PROVIDERS } from './llm-provider.interface';
import { LlmService } from './llm.service';
import { GlmProvider } from './providers/glm.provider';
import { LlmController } from './llm.controller';
import { LlmConfig } from './llm-config.entity';
import { User } from '../users/user.entity';
import { LlmConfigService } from './llm-config.service';
import { LlmConfigController } from './llm-config.controller';

/**
 * LLM 模块
 *
 * - 注册 GLM Provider 到 LLM_PROVIDERS token（数组形式，便于后续扩展多 Provider）
 * - 提供 LlmService 作为业务统一入口
 * - 暴露 /api/llm/health 健康检查接口
 * - LlmConfig 多套配置管理（admin CRUD + 用户选择）
 *
 * 业务模块如需 LLM 能力，只需 import LlmModule，再用 @OptionalLlm() 注入 LlmService：
 *   @Module({ imports: [LlmModule] })
 *   constructor(@OptionalLlm() private llm?: LlmService) {}
 *
 * LLM 未启用（LLM_ENABLED=false）时 LlmService.chat/embed 返回 null，不报错。
 */
@Module({
  imports: [TypeOrmModule.forFeature([LlmConfig, User])],
  controllers: [LlmController, LlmConfigController],
  providers: [
    GlmProvider,
    {
      // 把所有 Provider 注入到 LLM_PROVIDERS 数组 token
      provide: LLM_PROVIDERS,
      useFactory: (glm: GlmProvider) => [glm],
      inject: [GlmProvider],
    },
    LlmService,
    LlmConfigService,
  ],
  exports: [LlmService, LlmConfigService],
})
export class LlmModule {}

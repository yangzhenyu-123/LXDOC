import { Inject, Optional } from '@nestjs/common';
import { LlmService } from './llm.service';

/**
 * @OptionalLlm() 构造函数参数装饰器
 *
 * 用法：业务模块需要 LLM 能力时，构造函数参数标注：
 *   constructor(@OptionalLlm() private llm?: LlmService) {}
 *
 * 行为：
 * - LlmModule 已导出 LlmService 时正常注入实例
 * - LlmModule 未导入时参数为 undefined（@Optional 不强制依赖），业务层据此降级
 *
 * 业务层调用规范：
 *   const result = await this.llm?.chat([...]);
 *   if (!result) { /* LLM 未启用降级路径 *\/ }
 *
 * 实现：NestJS 的 @Optional() 与 @Inject() 都是参数装饰器，
 * 通过 reflect-metadata 写入 metadata，组合使用即可。
 */
export function OptionalLlm(): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    // 顺序：先 @Inject(token) 设定注入 token，再 @Optional() 标记可选
    Inject(LlmService)(target, propertyKey, parameterIndex);
    Optional()(target, propertyKey, parameterIndex);
  };
}

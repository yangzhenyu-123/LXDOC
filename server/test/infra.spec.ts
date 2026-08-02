/**
 * 基础设施验证测试
 * 确认 jest + ts-jest + @nestjs/testing 配置正确，可作为后续测试的模板。
 */
import { Test, TestingModule } from '@nestjs/testing';

describe('测试基础设施', () => {
  it('jest 与 ts-jest 工作', () => {
    expect(1 + 1).toBe(2);
  });

  it('Nest Testing 模块可用（最简空模块）', async () => {
    // createTestingModule 需 metadata 参数；空对象表示无 providers/controllers
    const moduleRef: TestingModule = await Test
      .createTestingModule({ providers: [] })
      .compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('async/await 工作', async () => {
    const result = await Promise.resolve('hello');
    expect(result).toBe('hello');
  });
});


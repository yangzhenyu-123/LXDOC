/**
 * Jest 配置（集成测试）
 *
 * 与 jest.config.ts 同源，仅差异：
 *   - testRegex 只匹配 *.integ.spec.ts
 *   - testTimeout 60s（Testcontainers 启 PG 需 10-20s + 测试执行）
 *   - 可选 maxWorkers=1（PG 容器串行启动，避免资源争抢）
 *
 * 运行：pnpm test:integration
 */
import type { Config } from 'jest';

const config: Config = {
  testRegex: ['src/.*\\.integ\\.spec\\.ts$', 'test/.*\\.integ\\.spec\\.ts$'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testEnvironment: 'node',
  // 集成测试启动 Testcontainers + DB schema 初始化，60s 兜底
  testTimeout: 60000,
  // 串行执行：PG 容器共享 / schema 隔离，避免并发资源争抢
  maxWorkers: 1,
  clearMocks: true,
  verbose: true,
};

export default config;

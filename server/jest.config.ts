/**
 * Jest 配置（后端）
 *
 * 测试分两层：
 *   unit        —— 单元测试，全 mock，无需外部依赖（最快）
 *   integration —— 集成测试，Testcontainers 启 PG+pgvector，mock GLM/TEI HTTP
 *
 * 运行：
 *   pnpm test              # 只跑 unit（快）
 *   pnpm test:integration  # 跑 integration（含 Testcontainers，较慢）
 *   pnpm test:all          # 全跑
 *
 * 命名约定：
 *   *.spec.ts —— 单元测试
 *   *.integ.spec.ts —— 集成测试（通过 testMatch 区分，单元默认不跑集成）
 */
import type { Config } from 'jest';

const config: Config = {
  // 测试文件：src 与 test 下的 *.spec.ts（默认排除 *.integ.spec.ts）
  testRegex: ['src/.*\\.spec\\.ts$', 'test/.*\\.spec\\.ts$'],
  // 排除集成测试（由 test:integration 单独跑）
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '\\.integ\\.spec\\.ts$',
  ],
  moduleFileExtensions: ['js', 'json', 'ts'],
  // ts-jest 转译 TS
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }],
  },
  // 别名：与 src import 一致（@/ → src/）
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // 测试环境：单元测试用 node（无 DOM）
  testEnvironment: 'node',
  // 超时：默认 5s，单元测试足够
  testTimeout: 10000,
  // 覆盖率（仅统计 src，排除 main.ts、entities、dto）
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/main.ts',
    '!src/**/*.entity.ts',
    '!src/**/*.dto.ts',
    '!src/**/*.module.ts',
  ],
  // 清除 mock 调用记录，避免跨用例污染
  clearMocks: true,
  // verbose 输出每个用例名
  verbose: true,
};

export default config;

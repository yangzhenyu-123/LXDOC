import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vitest 配置（前端）
 *
 * 与 vite.config.ts 同源（vue 插件 + @ 别名），仅增加 test 配置：
 * - environment: happy-dom（轻量 DOM，比 jsdom 快）
 * - globals: true（describe/it/expect 全局可用，与 jest 一致）
 * - include: src 与 test 下的 *.spec.ts
 *
 * 运行：pnpm test
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // 超时：SSE 解析测试可能较慢，给 10s
    testTimeout: 10000,
  },
});

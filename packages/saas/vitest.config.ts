/*
 * @file vitest 配置：单测 + 覆盖率门禁
 * @description @fw/saas 覆盖率阈值对齐框架包基线（lines/functions/statements ≥ 85%，branches ≥ 65%）。
 *   `fileParallelism: false`：与 queue/cache/tenant 包对齐，串行执行避免受限环境下 worker 池写临时目录失败。
 *   vite 8（rolldown + oxc）：显式开启 legacy 装饰器，使测试中声明的 @Injectable 能被正确降级。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    decorator: { legacy: true, emitDecoratorMetadata: true },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts', 'src/**/index.ts', 'src/types.ts', 'src/store.port.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 65,
        statements: 85,
      },
    },
  },
});

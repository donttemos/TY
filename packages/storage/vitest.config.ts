/*
 * @file vitest 配置：单测 + 覆盖率门禁
 * @description @fw/storage 覆盖率阈值对齐 @fw/cache 同档（lines/functions/statements ≥ 85%，branches ≥ 65%）。
 *   `fileParallelism: false`：本包含真实 Nest 容器装配用例，串行执行可避免受限环境下 worker 池
 *   写临时目录失败导致个别测试文件被静默跳过。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/storage
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vite 8（rolldown + oxc）：测试内声明的 @Module/@Injectable 需显式 legacy 装饰器（与 @fw/cache 同款）
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
      exclude: ['src/__tests__/**', 'src/**/*.d.ts', 'src/**/index.ts', 'src/types.ts', 'src/storage.port.ts', 'src/tokens.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 65,
        statements: 85,
      },
    },
  },
});

/*
 * @file vitest 配置：单测 + 覆盖率门禁
 * @description @fw/telemetry 覆盖率阈值与 @fw/transport 对齐（含 SDK 懒加载分支与采样决策路径）：
 *   lines/functions/statements ≥ 85%，branches ≥ 65%。
 *   `fileParallelism: false`：本包含 Nest 装配与全局 tracer 注册相关用例，串行执行可避免受限环境下
 *   worker 池写临时目录失败导致个别测试文件被静默跳过。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vite 8（rolldown + oxc）：显式开启 legacy 装饰器，使测试中声明的 @Module/@Injectable 能被正确降级
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
      exclude: [
        'src/__tests__/**',
        'src/**/*.d.ts',
        'src/**/*.index.ts',
        'src/types.ts',
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 65,
        statements: 85,
      },
    },
  },
});

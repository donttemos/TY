/*
 * @file vitest 配置：单测 + 覆盖率门禁
 * @description @fw/queue 覆盖率阈值对齐项目计划 §6 框架包基线（≥ 70%）并向上收紧至 cache 同级：
 *   lines/functions/statements ≥ 85%，branches ≥ 65%（队列含大量驱动分支与错误路径，分支阈值与 cache 齐平）。
 *   `fileParallelism: false`：本包含真实 Nest 容器装配与时钟相关用例，串行执行可避免受限环境下
 *   worker 池写临时目录失败导致个别测试文件被静默跳过。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vite 8（rolldown + oxc）：显式开启 legacy 装饰器，使测试中声明的 @Module/@Injectable/@JobHandler 能被正确降级
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
        'src/**/index.ts',
        'src/types.ts',
        'src/driver.port.ts',
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

/*
 * @file vitest 配置：单测 + 覆盖率门禁
 * @description @fw/transport 覆盖率阈值与 @fw/queue 对齐（队列/传输含大量驱动分支与错误路径）：
 *   lines/functions/statements ≥ 85%，branches ≥ 65%。
 *   `fileParallelism: false`：本包含 Nest 装配与 fake redis 时钟相关用例，串行执行可避免受限环境下
 *   worker 池写临时目录失败导致个别测试文件被静默跳过。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vite 8（rolldown + oxc）：显式开启 legacy 装饰器，使测试中声明的 @Module/@Injectable/@TransportHandler 能被正确降级
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

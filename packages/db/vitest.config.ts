/*
 * @file vitest 配置：单测 + 覆盖率门禁
 * @description @fw/db 覆盖率阈值对齐 PRD-002（orm ≥ 85%）：lines/functions/statements ≥ 85%，branches ≥ 65%
 * @author donttemo
 * @created 2026-10-12
 * @modified 2026-10-13 donttemo 适配 vite 8（rolldown + oxc）：显式开启 legacy 装饰器，使测试中声明的装饰器类可被正确降级
 * @module @fw/db
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vite 8 换成 rolldown + oxc 后，装饰器降级不再由 esbuild 按 tsconfig 自动完成：
  // oxc 按「文件是否被某个 tsconfig 覆盖」决定 legacy 装饰器，而本仓 tsconfig 普遍 exclude 掉
  // src/__tests__（测试文件与其中的 @Module/@Injectable 声明因此拿不到 experimentalDecorators），
  // 未被降级的 `@Decorator` 语法会被 Node 直接判为 SyntaxError。此处显式声明，与 tsc 行为对齐。
  oxc: {
    decorator: { legacy: true, emitDecoratorMetadata: true },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // 远端三库矩阵（MySQL/PostgreSQL）单用例含批量造数与多次网络往返，
    // 默认 5s 无法覆盖；本地 SQLite 用例远低于该阈值，放宽不影响离线反馈速度。
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // 仅统计 src 业务代码，不含测试自身
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts', 'src/**/index.ts'],
      thresholds: {
        // 全局门槛：项目计划 §6 要求 orm 覆盖率 ≥ 85%
        lines: 85,
        functions: 85,
        branches: 65,
        statements: 85,
      },
    },
  },
});

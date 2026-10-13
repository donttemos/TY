/*
 * @file vitest 配置：单测 + 覆盖率门禁
 * @description @fw/auth 覆盖率阈值对齐项目计划（auth ≥ 85%）：lines/functions/statements ≥ 85%，branches ≥ 65%
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // 仅统计 src 业务代码：排除测试、纯类型入口与 interface-only 文件（无可执行代码）
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts', 'src/**/index.ts', 'src/types.ts', 'src/auth-store.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 65,
        statements: 85,
      },
    },
  },
});

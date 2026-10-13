/*
 * @file vitest 配置（覆盖率与门槛）
 * @description 强制覆盖率门槛：单测覆盖率 < 80% 时 CI 阻断；@vitest/coverage-v8 提供行/分支/函数指标。
 * @author donttemo
 * @created 2026-10-12
 * @since v0.1.0
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        // PRD-001 AC 要求 core/config/logger 行/函数覆盖率 ≥ 80%；分支门槛适当放宽（M2 起随集成测试补齐）
        lines: 80,
        functions: 80,
        branches: 60,
        statements: 80,
      },
      // 仅统计 src 业务代码，不含测试自身与启动引导（bootstrap 需真实监听端口，集成测试覆盖）
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts', 'src/**/index.ts', 'src/bootstrap.ts'],
    },
  },
});

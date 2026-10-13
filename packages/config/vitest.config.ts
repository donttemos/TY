/*
 * @file @fw/config vitest 配置（覆盖率与门槛）
 * @description 行/函数/语句 ≥ 80%，branches ≥ 60%；与 core 策略一致
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
        lines: 80,
        functions: 80,
        branches: 60,
        statements: 80,
      },
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts', 'src/**/index.ts'],
    },
  },
});

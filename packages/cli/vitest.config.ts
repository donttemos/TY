/*
 * @file @fw/cli vitest 配置：单测 + 覆盖率底线
 * @description 已覆盖：参数解析与分派（args.ts 100%）、模板生成（new.ts 94%）、配置自检（check.ts 100%）。
 *   未覆盖：index.ts（进程入口，import 即执行 main，无法在进程内单测）、db.ts / run.ts（包装 pnpm、prisma 外部命令，
 *   真实行为由 M2 数据库迁移演练与 M3/M4 端到端冒烟覆盖）。
 *   底线取 40%（略低于当前实测），作为防退化门禁；§4.3 要求的 80% 面向生成器，随 M6 交付后提升阈值。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cli
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts'],
      thresholds: {
        lines: 40,
        functions: 40,
        branches: 40,
        statements: 40,
      },
    },
  },
});

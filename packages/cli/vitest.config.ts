/*
 * @file @fw/cli vitest 配置：单测 + 覆盖率底线
 * @description 覆盖范围：参数解析与分派（args.ts 100%）、模板生成（new.ts 94%）、配置自检（check.ts 100%）、
 *   M6 生成器全家桶（src/gen/** 实测 90%+，PRD-006 NFR 要求生成器 ≥80%）。
 *   不计入统计：index.ts（进程入口，import 即执行 main，无法在进程内单测）、db.ts / run.ts
 *   （包装 pnpm / prisma 外部命令，真实行为由 M2 数据库迁移演练与 M3/M4 端到端冒烟覆盖）。
 *   阈值 80%：M6 交付时按 PRD-006 §4.3 从 40% 提升，当前实测约 92%，留退化余量。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 适配 vite 8（rolldown + oxc）：显式开启 legacy 装饰器，使测试中声明的装饰器类可被正确降级
 * @modified 2026-10-13 donttemo M6：纳入 src/gen/**，阈值 40% → 80%（PRD-006 NFR），排除外部命令包装与进程入口
 * @module @fw/cli
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vite 8 起转换器换成 rolldown + oxc：装饰器降级不再按 tsconfig 自动生效（oxc 只在文件被某个
  // tsconfig 覆盖时才启用 legacy 装饰器），而本仓 tsconfig 普遍 exclude 掉 src/__tests__ →
  // 测试里声明的 @Module/@Injectable 会被原样保留，Node 直接判 SyntaxError。此处显式声明，与 tsc 对齐。
  oxc: {
    decorator: { legacy: true, emitDecoratorMetadata: true },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // 只统计「可在进程内单测」的源码；外部命令包装（db/run）与进程入口（index）由端到端演练覆盖
      include: ['src/gen/**/*.ts', 'src/deploy/**/*.ts', 'src/verify/**/*.ts', 'src/args.ts', 'src/commands/check.ts', 'src/commands/new.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});

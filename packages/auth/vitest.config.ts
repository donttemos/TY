/*
 * @file vitest 配置：单测 + 覆盖率门禁
 * @description @fw/auth 覆盖率阈值对齐项目计划（auth ≥ 85%）：lines/functions/statements ≥ 85%，branches ≥ 65%
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 适配 vite 8（rolldown + oxc）：显式开启 legacy 装饰器，使测试中声明的装饰器类可被正确降级
 * @module @fw/auth
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

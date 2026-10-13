/*
 * @file vitest 配置：单测 + 覆盖率门禁
 * @description @fw/cache 覆盖率阈值对齐项目计划 §6（cache ≥ 85%）：lines/functions/statements ≥ 85%，branches ≥ 65%。
 *   `fileParallelism: false`：本包含真实 Nest 容器装配与时钟相关用例，串行执行可避免
 *   受限环境下 worker 池写临时目录失败导致个别测试文件被静默跳过（不影响用例结果与耗时量级）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 适配 vite 8（rolldown + oxc）：显式开启 legacy 装饰器，使测试中声明的装饰器类可被正确降级
 * @module @fw/cache
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
    // 见文件头说明：串行执行保证「全部测试文件都被执行」，避免覆盖率虚高
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // 仅统计 src 业务代码：排除测试自身、纯类型声明（无运行时代码）与内部入口
      include: ['src/**/*.ts'],
      exclude: [
        'src/__tests__/**',
        'src/**/*.d.ts',
        'src/**/index.ts',
        'src/types.ts',
        'src/store.port.ts',
      ],
      thresholds: {
        // 项目计划 §6：cache 覆盖率 ≥ 85%
        lines: 85,
        functions: 85,
        branches: 65,
        statements: 85,
      },
    },
  },
});

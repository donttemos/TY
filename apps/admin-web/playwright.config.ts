/*
 * @file Playwright 配置（PRD-016 FR-16-17）
 * @description 只跑 chromium：黄金链路验的是「真实浏览器能完成增删改查」，不需要跨浏览器矩阵。
 *   baseURL / 产物目录经环境变量注入，由 `fw verify` 传入，因此同一份用例能对本地 dev server
 *   与真机部署实例跑。
 * @author donttemo
 * @created 2026-10-22
 * @module admin-web/e2e
 */

import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const outputDir = process.env.E2E_OUTPUT ?? 'e2e-artifacts';

export default defineConfig({
  testDir: './e2e',
  outputDir,
  // 失败留 trace 与截图：没有现场证据的 E2E 失败等于没失败
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
  // 单条流程、串行执行：登录有限流，并行会互相打满
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

/*
 * @file 管理后台前端 vitest 配置
 * @description 单测覆盖请求层（错误码映射 / 无感刷新）、权限路由生成、v-permission 指令、CrudTable 渲染；
 *   环境用 happy-dom（轻量 DOM），测试文件与源码同目录 __tests__（tsc 类型检查不覆盖测试内的 any 断言写法由 strict 约束）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web
 */

import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: true,
  },
});

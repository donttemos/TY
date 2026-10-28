/*
 * @file studio-web 构建配置
 * @description 产物是纯静态（base 用相对路径），由 `fw studio` 的本地服务托管，
 *   因此不假设任何固定部署路径，也不与 admin-web 共用构建配置或运行时。
 * @author donttemo
 * @created 2026-10-22
 * @module studio-web
 */

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    // 产物直接放在包内 dist，服务端按目录托管
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    // 本地开发时把 /api 转发给 fw studio（默认 4310），避免手工配置跨域
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4310',
        changeOrigin: false,
      },
    },
  },
});

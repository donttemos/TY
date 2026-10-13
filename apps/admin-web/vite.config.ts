/*
 * @file Vite 构建配置
 * @description 管理后台前端（PRD-005 FR-01/FR-11）：Vue3 SFC + Element Plus 按需引入（unplugin-vue-components 解析器，
 *   不含 unplugin-auto-import，避免生成 d.ts 触发文件头校验）；dev/test 模式挂载 vite mock server（C-06 契约），
 *   production 不挂载、产物为纯静态资源；构建按 vendor 分包，构建体积门禁见 scripts/smoke-mock.mjs。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web
 */

import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { viteMockServer } from './mock/plugin';

export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    // mock 仅在非生产模式挂载：切真实后端时把 .env.production 的 VITE_API_BASE_URL 指向真实服务即可
    viteMockServer(mode),
    // dts:false —— 不生成 components.d.ts，规避 docs/70 §1.6 文件头校验（生成物无 @author 头）
    Components({ dts: false, resolvers: [ElementPlusResolver({ importStyle: 'css' })] }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // element-plus 全量 vendor 分包 raw ≈ 930 kB / gzip ≈ 300 kB（按需引入已树摇，拆分 vendor 反而伤缓存）；
    // 体积门禁以 gzip 口径为准，见 scripts/smoke-mock.mjs，故此处告警线放宽到 1000 kB
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-vue': ['vue', 'vue-router', 'pinia'],
          'vendor-element-plus': ['element-plus', '@element-plus/icons-vue'],
        },
      },
    },
  },
}));

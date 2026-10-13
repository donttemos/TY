/*
 * @file Vite 构建配置
 * @description 管理后台前端（PRD-005 FR-01/FR-11）：Vue3 SFC + Element Plus 按需引入（unplugin-vue-components 解析器，
 *   不含 unplugin-auto-import，避免生成 d.ts 触发文件头校验）；dev/test 模式挂载 vite mock server（C-06 契约），
 *   production 不挂载、产物为纯静态资源；构建按 vendor 分包，构建体积门禁见 scripts/smoke-mock.mjs。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo vite 8（rolldown）适配：manualChunks 由对象形式改为函数形式
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
        // rolldown（vite 8 起）只接受函数形式的 manualChunks，对象形式会被忽略并告警；
        // 按模块实际路径分组：pnpm 布局下依赖位于 node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/，
        // 因此统一匹配「/node_modules/<pkg>/」片段即可同时覆盖常规布局与 pnpm 布局。
        manualChunks(id: string): string | undefined {
          if (id.includes('/node_modules/element-plus/') || id.includes('/node_modules/@element-plus/')) {
            return 'vendor-element-plus';
          }
          if (/\/node_modules\/(vue|vue-router|pinia|@vue)\//.test(id)) return 'vendor-vue';
          return undefined;
        },
      },
    },
  },
}));

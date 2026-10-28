/*
 * @file Vite 构建配置
 * @description 管理后台前端（admin 模板）：Vue3 SFC + Element Plus 按需引入（unplugin-vue-components 解析器，
 *   不含 unplugin-auto-import，避免生成 d.ts 触发文件头校验）；模板不挂 mock，dev 经 VITE_API_BASE_URL 指向服务端；产物为纯静态资源；构建按 vendor 分包。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo vite 8（rolldown）适配：manualChunks 由对象形式改为函数形式
 * @modified 2026-10-28 donttemo 补 preview.proxy：`fw verify` 改为对构建产物起 preview 做浏览器验收
 *   （dev server 的依赖预构建会在首屏返回 504 Outdated Optimize Dep，导致路由起不来）
 * @module admin-web
 */

import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';

export default defineConfig(() => ({
  plugins: [
    vue(),
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
    // dev 代理：前端默认 VITE_API_BASE_URL=/api/v1（同源），经此转发到服务端；改指其他网关时改 .env.development
    proxy: {
      '/api': {
        target: process.env.DEV_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  // 预览代理与 dev 同口径：`fw verify` 用「构建产物 + preview」跑浏览器验收，
  // 走的是用户真正会部署的那份产物（dev server 的依赖预构建会在首屏返回 504 Outdated Optimize Dep，
  // 让浏览器拿到「模块加载失败」，那是 dev 期独有的假故障）
  preview: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: process.env.DEV_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // element-plus 全量 vendor 分包 raw ≈ 930 kB / gzip ≈ 300 kB（按需引入已树摇，拆分 vendor 反而伤缓存）；
    // 模板无体积门禁，告警线放宽到 1000 kB
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

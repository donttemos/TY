/*
 * @file 管理后台前端 vitest 配置
 * @description 单测覆盖错误码映射、权限路由生成（含 component 解析与子路由相对路径拼接）、
 *   CrudTable 四态与权限按钮。环境用 happy-dom（轻量 DOM），测试文件与源码同目录 __tests__；
 *   挂 @vitejs/plugin-vue 与 unplugin-vue-components（Element Plus 解析器）
 *   使 SFC 与 el-* 组件在测试中可正常编译解析。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 适配 vite 8（rolldown + oxc）：显式开启 legacy 装饰器，使测试中声明的装饰器类可被正确降级
 * @module admin-web
 */

import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vite 8 起转换器换成 rolldown + oxc：装饰器降级不再按 tsconfig 自动生效（oxc 只在文件被某个
  // tsconfig 覆盖时才启用 legacy 装饰器），而本仓 tsconfig 普遍 exclude 掉 src/__tests__ →
  // 测试里声明的 @Module/@Injectable 会被原样保留，Node 直接判 SyntaxError。此处显式声明，与 tsc 对齐。
  oxc: {
    decorator: { legacy: true, emitDecoratorMetadata: true },
  },
  plugins: [
    vue(),
    // dts:false —— 不生成 components.d.ts，规避文件头校验（生成物无 @author 头）；
    // importStyle:false —— 测试环境不引入 theme-chalk 的 css（Node 侧无 CSS 处理管道）
    Components({ dts: false, resolvers: [ElementPlusResolver({ importStyle: false })] }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});

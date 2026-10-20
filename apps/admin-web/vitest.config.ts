/*
 * @file 管理后台前端 vitest 配置
 * @description 单测覆盖错误码映射、权限路由生成（含 component 解析与子路由相对路径拼接）、
 *   CrudTable 四态与权限按钮。环境用 happy-dom（轻量 DOM），测试文件与源码同目录 __tests__；
 *   挂 @vitejs/plugin-vue 与 unplugin-vue-components（Element Plus 解析器）
 *   使 SFC 与 el-* 组件在测试中可正常编译解析。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 适配 vite 8（rolldown + oxc）：显式开启 legacy 装饰器，使测试中声明的装饰器类可被正确降级
 * @modified 2026-10-14 donttemo 注入测试期 VITE_API_BASE_URL：.env.* 被 gitignore，干净环境（CI）缺少
 *   .env.test 时 token 存储判定为未启用，「无感刷新」3 个用例必挂；改为在 config 内固定，测试不依赖本地 env 文件
 * @modified 2026-10-14 donttemo 真机修复后续：移除 test.env 注入。令牌存储开关已改为专用 VITE_AUTH_STORAGE
 *   且默认启用，API 基址亦有同源兜底，测试不再依赖任何 env 变量
 * @modified 2026-10-20 donttemo M15 安全加固：include 增加 mock 目录下的 __tests__（mock 侧 CSV 单元格编码与
 *   @fw/auth 同源，必须有行为单测，否则漂移只在真机导出产物上才暴露）
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
    // mock/ 也在测试范围内：mock 侧有自己的纯逻辑（如审计导出 CSV 单元格编码，与 @fw/auth 同源），
    // 只收 src/** 会让「mock 实现与后端漂移」没有任何单测兜底（triway 轴 H 只对撞锚点，不对撞行为）
    include: ['src/**/__tests__/**/*.test.ts', 'mock/**/__tests__/**/*.test.ts'],
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // 视图级测试全量挂载 ElementPlus + CrudTable 远程表格，慢机器/CI 争用下可达 5~10s；
    // 默认 5s 会把「挂载慢」误报成用例失败（M14 收口日实测踩坑），统一放宽到 30s。
    testTimeout: 30_000,
  },
});

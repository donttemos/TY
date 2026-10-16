/*
 * @file 应用入口
 * @description 装配顺序：Element Plus 基础样式 → Pinia → Router → v-permission 指令 → 挂载；
 *   错误提示统一走 ElementPlusResolver 解析的组件 + request 层 BizError 映射。
 * @modified 2026-10-15 donttemo M10/E-17：挂载前安装 RUM（window error / unhandledrejection /
 *   Vue errorHandler 三源采集，批量 sendBeacon 上报；VITE_RUM_ENABLED=false 可关）
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { permission } from './directives/permission';
import { installRum } from './utils/rum';
import './styles/index.css';

const app = createApp(App);

// M10/E-17：前端错误监控（fire-and-forget，默认开启；显式 VITE_RUM_ENABLED=false 关闭）
if (import.meta.env.VITE_RUM_ENABLED !== 'false') {
  installRum(app);
}

app.use(createPinia());
app.use(router);
app.directive('permission', permission);

app.mount('#app');

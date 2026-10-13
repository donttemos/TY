/*
 * @file 应用入口
 * @description 装配顺序：Element Plus 基础样式 → Pinia → Router → v-permission 指令 → 挂载；
 *   错误提示统一走 ElementPlusResolver 解析的组件 + request 层 BizError 映射。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { permission } from './directives/permission';
import './styles/index.css';

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.directive('permission', permission);

app.mount('#app');

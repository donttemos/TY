<!--
 * @file 根组件
 * @description 应用外壳：ElConfigProvider 接线 Element Plus locale（E-14 i18n 骨架——切换语言即时生效，
 *   组件库内置文案走 useLocale 的 elLocale）+ 挂载路由视图；主题（暗色 / 紧凑）由 app store 在 html 上切换 class。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo E-14：路由视图包入 ElConfigProvider，locale 接线见 composables/useLocale.ts
 * @module admin-web
-->

<script setup lang="ts">
import { useAppStore } from '@/store/app';
import { useLocale } from '@/composables/useLocale';

// 立即应用本地持久化的外观（暗色 / 紧凑 / 主色），避免首屏闪烁
useAppStore();

// locale（模块级响应式 + localStorage 持久化）：el-config-provider 消费 Element Plus 内置文案
const { elLocale } = useLocale();
</script>

<template>
  <el-config-provider :locale="elLocale">
    <router-view />
  </el-config-provider>
</template>

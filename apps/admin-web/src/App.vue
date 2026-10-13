<!--
 * @file 根组件
 * @description 应用外壳：挂载路由视图；主题（暗色 / 紧凑）由 app store 在 html 上切换 class。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web
-->

<script setup lang="ts">
import { useAppStore } from '@/store/app';

// 立即应用本地持久化的外观（暗色 / 紧凑 / 主色），避免首屏闪烁
useAppStore();
</script>

<template>
  <router-view />
</template>

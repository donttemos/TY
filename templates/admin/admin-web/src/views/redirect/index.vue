<!--
 * @file 重定向页（标签页「刷新」用）
 * @description 跳转到 /redirect/<原路径> 后立即 replace 回原路径，利用组件重建实现「刷新当前页」，
 *   比 router.go(0) 轻（不重发静态资源请求）。
 * @author donttemo
 * @created 2026-10-13
 * @module __APP_NAME__-web/views
-->

<script setup lang="ts">
import { onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();

onMounted(() => {
  const target = route.params.pathMatch ? `/${(route.params.pathMatch as string[]).join('/')}` : '/dashboard';
  void router.replace(target + (route.hash ?? ''));
});
</script>

<template>
  <div />
</template>

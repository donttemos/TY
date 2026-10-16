<!--
 * @file 面包屑
 * @description 由当前路由 matched 链生成（含动态路由 meta.title）；支持点击跳转上级。
 * @author donttemo
 * @created 2026-10-13
 * @module __APP_NAME__-web/layout
-->

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { RouteLocationMatched } from 'vue-router';

const route = useRoute();
const router = useRouter();

interface Crumb {
  title: string;
  path: string | null;
  clickable: boolean;
}

const crumbs = computed<Crumb[]>(() => {
  const matched = route.matched.filter((m) => m.meta?.title && !m.meta.hiddenInMenu);
  return matched.map((m: RouteLocationMatched, index: number) => ({
    title: String(m.meta.title),
    // 末级为当前页（不可点）；上级用路由记录路径（menu 目录均为静态段，可直接跳转）
    path: index === matched.length - 1 ? null : m.path,
    clickable: index !== matched.length - 1,
  }));
});

function go(crumb: Crumb): void {
  if (crumb.path) void router.push(crumb.path);
}
</script>

<template>
  <el-breadcrumb separator="/" class="fw-breadcrumb">
    <el-breadcrumb-item v-for="(crumb, index) in crumbs" :key="index">
      <span v-if="!crumb.clickable" class="fw-breadcrumb-current">{{ crumb.title }}</span>
      <a v-else class="fw-breadcrumb-link" @click="go(crumb)">{{ crumb.title }}</a>
    </el-breadcrumb-item>
  </el-breadcrumb>
</template>

<style scoped>
.fw-breadcrumb {
  font-size: 14px;
}

.fw-breadcrumb-current {
  color: var(--fw-text-2);
}

.fw-breadcrumb-link {
  color: var(--fw-text-3);
  cursor: pointer;
}

.fw-breadcrumb-link:hover {
  color: var(--el-color-primary);
}
</style>

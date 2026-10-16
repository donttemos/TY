<!--
 * @file 侧边栏菜单项（递归组件）
 * @description 渲染单个菜单节点：有子菜单用 el-sub-menu，叶子用菜单项链接；
 *   只展示 permission store 下发的可见菜单（后端已过滤 + 前端二次过滤）。
 * @author donttemo
 * @created 2026-10-13
 * @module __APP_NAME__-web/layout
-->

<script setup lang="ts">
import type { MenuNode } from '@/api/types';
import { resolveIcon } from './icon-map';

defineProps<{ item: MenuNode; collapsed: boolean }>();
</script>

<template>
  <el-sub-menu v-if="item.children.length > 0" :index="item.path ?? item.id">
    <template #title>
      <el-icon><component :is="resolveIcon(item.icon)" /></el-icon>
      <span>{{ item.name }}</span>
    </template>
    <sidebar-item v-for="child in item.children" :key="child.id" :item="child" :collapsed="collapsed" />
  </el-sub-menu>
  <el-menu-item v-else :index="item.path ?? item.id">
    <el-icon><component :is="resolveIcon(item.icon)" /></el-icon>
    <template #title>{{ item.name }}</template>
  </el-menu-item>
</template>

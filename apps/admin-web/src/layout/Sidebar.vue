<!--
 * @file 侧边栏
 * @description Logo + 菜单（菜单数据来自 /auth/menus，按权限过滤）；折叠态仅图标；
 *   768–1280 自动折叠为图标、<768 由抽屉承载（响应式规则见原型 §8）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/layout
-->

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { usePermissionStore } from '@/store/permission';
import { useAppStore } from '@/store/app';
import SidebarItem from './SidebarItem.vue';

const permission = usePermissionStore();
const app = useAppStore();
const route = useRoute();

const menus = computed(() => permission.visibleMenus());

/** 当前激活菜单：取路由 path 匹配的菜单 path（父级目录高亮） */
const activeMenu = computed(() => route.path);
</script>

<template>
  <aside class="fw-sidebar" :class="{ collapsed: app.state.sidebarCollapsed }">
    <div class="fw-sidebar-logo">
      <span v-show="!app.state.sidebarCollapsed" class="fw-sidebar-logo-text">通用应用框架</span>
      <span v-show="app.state.sidebarCollapsed" class="fw-sidebar-logo-mini">FW</span>
    </div>
    <el-menu
      :default-active="activeMenu"
      :collapse="app.state.sidebarCollapsed"
      :collapse-transition="false"
      router
      class="fw-sidebar-menu"
    >
      <sidebar-item v-for="item in menus" :key="item.id" :item="item" :collapsed="app.state.sidebarCollapsed" />
    </el-menu>
  </aside>
</template>

<style scoped>
.fw-sidebar {
  width: var(--fw-sidebar-width);
  height: 100%;
  background: var(--fw-surface);
  border-right: 1px solid var(--fw-border);
  transition: width 0.2s;
  display: flex;
  flex-direction: column;
}

.fw-sidebar.collapsed {
  width: var(--fw-sidebar-collapsed-width);
}

.fw-sidebar-logo {
  height: var(--fw-navbar-height);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  border-bottom: 1px solid var(--fw-border);
  white-space: nowrap;
  overflow: hidden;
}

.fw-sidebar-logo-mini {
  color: var(--el-color-primary);
  font-size: 18px;
}

.fw-sidebar-menu {
  flex: 1;
  border-right: none;
  overflow-y: auto;
}

/* 折叠态隐藏 sub-menu 弹出层的动画抖动 */
.fw-sidebar-menu:not(.el-menu--collapse) {
  width: var(--fw-sidebar-width);
}
</style>

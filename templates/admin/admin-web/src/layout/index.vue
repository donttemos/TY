<!--
 * @file 全局布局（侧边栏 + 顶栏 + 内容区）
 * @description 响应式规则（原型 §8）：≥1280 完整侧边栏；768–1280 自动折叠为图标；<768 抽屉式。
 *   宽度监听用 matchMedia，断点变化只改 app store，不直接操作 DOM。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo admin 模板：不含任务中心（N-02 为 example-api 专项），移除 JobBar 与 其延续说明。原 N-02 说明：
 *   长任务（导出 / 租户迁移）派发后不阻塞页面，进度与下载入口全局可见
 * @module __APP_NAME__-web/layout
-->

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Sidebar from './Sidebar.vue';
import Navbar from './Navbar.vue';
import AppMain from './AppMain.vue';
import { useAppStore } from '@/store/app';

const app = useAppStore();
const mobileDrawer = ref(false);

/** 断点监听：768–1280 自动折叠，<768 走抽屉 */
function handleBreakpoint(): void {
  const width = window.innerWidth;
  if (width < 768) {
    mobileDrawer.value = true;
  } else {
    mobileDrawer.value = false;
    if (width < 1280) {
      app.setSidebarCollapsed(true);
    } else if (app.state.sidebarCollapsed) {
      // 仅自动折叠的场景下恢复；用户手动折叠的状态由 localStorage 保留
      app.setSidebarCollapsed(false);
    }
  }
}

onMounted(() => {
  handleBreakpoint();
  window.addEventListener('resize', handleBreakpoint);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleBreakpoint);
});
</script>

<template>
  <div class="fw-layout" :class="{ mobile: mobileDrawer }">
    <!-- 桌面：固定侧边栏 -->
    <div v-if="!mobileDrawer" class="fw-layout-side">
      <Sidebar />
    </div>

    <!-- 移动端：抽屉侧边栏 -->
    <el-drawer v-else v-model="mobileDrawer" direction="ltr" size="200px" :with-header="false">
      <Sidebar />
    </el-drawer>

    <div class="fw-layout-body">
      <Navbar />
      <AppMain />
    </div>
  </div>
</template>

<style scoped>
.fw-layout {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.fw-layout-side {
  height: 100%;
}

.fw-layout-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
</style>

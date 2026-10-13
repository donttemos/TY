<!--
 * @file 主内容区（含多标签页与路由视图）
 * @description keep-alive 缓存已访问页面（按路由 name），切回不重复请求；
 *   router-view 的 key 用 fullPath 保证同路由不同参数重新渲染。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/layout
-->

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import TagsView from './TagsView.vue';

const route = useRoute();
const viewKey = computed(() => route.fullPath);
</script>

<template>
  <section class="fw-app-main">
    <TagsView />
    <div class="fw-app-content">
      <router-view v-slot="{ Component }">
        <keep-alive :include="[]">
          <component :is="Component" :key="viewKey" />
        </keep-alive>
      </router-view>
    </div>
  </section>
</template>

<style scoped>
.fw-app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.fw-app-content {
  flex: 1;
  overflow: auto;
  padding: 0;
}
</style>

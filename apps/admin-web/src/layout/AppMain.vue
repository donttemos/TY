<!--
 * @file 主内容区（含多标签页与路由视图）
 * @description keep-alive 缓存已访问页面（按路由 name / fullPath），切回不重复请求；
 *   router-view 的 key 用 fullPath 保证同路由不同参数重新渲染。
 * @modified 2026-10-15 donttemo M10/E-16：:max 条数上限从硬编码 12 改为配置中心下发
 *   （web.keepAliveMax / WEB_KEEP_ALIVE_MAX，读取失败回退默认 12）
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 修复 keep-alive 失效：原 `:include="[]"` 空数组不匹配任何组件名，
 *   等于关闭缓存（与组件注释相矛盾，切回页面仍会重新请求）；改为不设 include + `:max` LRU 上限，
 *   缓存以 fullPath 为键；标签页「刷新」仍走 /redirect 强制重建
 * @module admin-web/layout
-->

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import TagsView from './TagsView.vue';
import { useWebLimitsStore } from '@/store/web-limits';

const route = useRoute();
const viewKey = computed(() => route.fullPath);
// M10/E-16：keep-alive LRU 条数经配置中心下发（失败回退默认 12，见 store/web-limits）
const webLimits = useWebLimitsStore();
onMounted(() => {
  void webLimits.load();
});
</script>

<template>
  <section class="fw-app-main">
    <TagsView />
    <div class="fw-app-content">
      <router-view v-slot="{ Component }">
        <!-- 不设 include（空数组会让 keep-alive 完全不生效）；:max 走 LRU 淘汰，避免标签越开越多占内存（条数可配：web.keepAliveMax） -->
        <keep-alive :max="webLimits.keepAliveMax">
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

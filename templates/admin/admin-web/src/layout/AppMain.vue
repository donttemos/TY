<!--
 * @file 主内容区（含多标签页与路由视图）
 * @description keep-alive 缓存已访问页面（按路由 name / fullPath），切回不重复请求；
 *   router-view 的 key 用 fullPath 保证同路由不同参数重新渲染。
 * @modified 2026-10-17 donttemo 三方一致性门禁：keep-alive 条数上限从「配置中心下发」改回常量——
 *   模板服务端未接入配置中心（GET /configs 必 404），store/web-limits 每次布局挂载都在打必败请求；
 *   需要运行时下发时参照 apps/admin-web 的 store/web-limits 与 example-api 配置中心补回
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 修复 keep-alive 失效：原 `:include="[]"` 空数组不匹配任何组件名，
 *   等于关闭缓存（与组件注释相矛盾，切回页面仍会重新请求）；改为不设 include + `:max` LRU 上限，
 *   缓存以 fullPath 为键；标签页「刷新」仍走 /redirect 强制重建
 * @module __APP_NAME__-web/layout
-->

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import TagsView from './TagsView.vue';

const route = useRoute();
const viewKey = computed(() => route.fullPath);
/** keep-alive LRU 条数上限（模板不含配置中心，取默认值 12；与 apps/admin-web 的默认口径一致） */
const KEEP_ALIVE_MAX = 12;
</script>

<template>
  <section class="fw-app-main">
    <TagsView />
    <div class="fw-app-content">
      <router-view v-slot="{ Component }">
        <!-- 不设 include（空数组会让 keep-alive 完全不生效）；:max 走 LRU 淘汰，避免标签越开越多占内存（条数可配：web.keepAliveMax） -->
        <keep-alive :max="KEEP_ALIVE_MAX">
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

<!--
 * @file 平台审计页（跨租户维护入口，PRD-008 FR-02 / PRD-015 FR-15-20）
 * @description 运营审计视图的跨租户模式：同一份列表/详情/导出实现，数据源换成
 *   `/audit-logs/platform*`。服务端仅对带 `@IgnoreTenant()` + `system:tenant:ignore` 的
 *   平台维护入口放开租户维度，归属人（dataScope）范围照旧收敛；普通 `/audit-logs*`
 *   不受本页影响，仍强制当前租户。
 *   入口可见性由菜单权限码 `system:tenant:ignore` 决定（动态路由不下发 → 直输 URL 落 403/404），
 *   页面内 `allowed` 再做一次权限门禁，服务端守卫是最终防线（三层各自独立）。
 * @author donttemo
 * @created 2026-10-21
 * @module admin-web/views
-->

<script setup lang="ts">
import AuditLogPage from '../index.vue';
</script>

<template>
  <AuditLogPage cross-tenant />
</template>

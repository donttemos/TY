<!--
 * @file 403 无权限页
 * @description 动态路由拦截落地页（TC-WEB-001）：用户直接输入未授权 URL 时展示；提供返回工作台入口。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/views
-->

<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="fw-error-page">
    <el-result icon="warning" title="403" sub-title="抱歉，你无权访问该页面（或页面不存在）">
      <template #extra>
        <el-button type="primary" @click="router.push('/dashboard')">返回工作台</el-button>
      </template>
    </el-result>
  </div>
</template>

<style scoped>
.fw-error-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>

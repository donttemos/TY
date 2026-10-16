<!--
 * @file 404 页面不存在
 * @description 兜底路由页面（路由表未匹配的路径）；与 403 的区别：403=无权限，404=不存在。
 * @author donttemo
 * @created 2026-10-13
 * @module __APP_NAME__-web/views
-->

<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="fw-error-page">
    <el-result icon="error" title="404" sub-title="抱歉，你访问的页面不存在">
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

<!--
 * @file 套餐管理页（M13，PRD-013 §2.3）
 * @description 平台运营视角：套餐列表 + 版本抽屉（版本递增发布、发布后不可变——版本仅可查看，
 *   发布走脚本/后续批次端点）。权限 ops:saas:read；无权限时菜单不出现、直输 URL 落 403。
 * @author donttemo
 * @created 2026-10-19
 * @module admin-web/views
-->

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import * as saasApi from '@/api/saas';
import type { PlanView } from '@/api/types';
import { BizError, describeBizError } from '@/utils/biz-error';

const loading = ref(false);
const plans = ref<PlanView[]>([]);
const drawerVisible = ref(false);
const currentPlan = ref<PlanView | null>(null);
const versions = ref<Array<{ version: number; status: string; publishedAt: string | null; quotas: Array<{ quotaKey: string; limitValue: string; execution: string | null }> }>>([]);
const versionsLoading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    plans.value = await saasApi.fetchPlans();
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    loading.value = false;
  }
}

async function openVersions(plan: PlanView): Promise<void> {
  currentPlan.value = plan;
  drawerVisible.value = true;
  versionsLoading.value = true;
  try {
    versions.value = await saasApi.fetchPlanVersions(plan.id);
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    versionsLoading.value = false;
  }
}

onMounted(load);

import { ElMessage } from 'element-plus';
</script>

<template>
  <div class="page">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>套餐管理</span>
          <el-button type="primary" plain size="small" @click="load">刷新</el-button>
        </div>
      </template>
      <el-table v-loading="loading" :data="plans" border>
        <el-table-column prop="code" label="编码" min-width="120" />
        <el-table-column prop="name" label="名称" min-width="140" />
        <el-table-column prop="description" label="描述" min-width="220" show-overflow-tooltip />
        <el-table-column label="操作" width="120" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click="openVersions(row)">版本与配额</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-drawer v-model="drawerVisible" :title="`版本：${currentPlan?.name ?? ''}`" size="55%">
      <el-table v-loading="versionsLoading" :data="versions" border>
        <el-table-column prop="version" label="版本" width="80" align="center" />
        <el-table-column prop="status" label="状态" width="110" align="center" />
        <el-table-column prop="publishedAt" label="发布时间" width="180" />
        <el-table-column label="配额默认项" min-width="280">
          <template #default="{ row }">
            <el-tag v-for="q in row.quotas" :key="q.quotaKey" class="quota-tag" size="small">
              {{ q.quotaKey }} ≤ {{ q.limitValue }}（{{ q.execution ?? 'hard' }}）
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-drawer>
  </div>
</template>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.quota-tag {
  margin-right: 6px;
}
</style>

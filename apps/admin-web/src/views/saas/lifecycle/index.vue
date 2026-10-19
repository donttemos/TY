<!--
 * @file 租户生命周期页（M13，PRD-013 §2.3 / ADR-0031）
 * @description 按租户执行生命周期迁移（六动作，非法迁移 4030 由后端状态机拒绝、重复执行幂等
 *   alreadyApplied）+ 迁移历史（只增不改不删）。权限 ops:saas:read / ops:saas:write。
 * @author donttemo
 * @created 2026-10-19
 * @module admin-web/views
-->

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import * as saasApi from '@/api/saas';
import type { LifecycleLog } from '@/api/types';
import { BizError, describeBizError } from '@/utils/biz-error';

const ACTIONS: Array<{ action: string; label: string; danger?: boolean }> = [
  { action: 'activate', label: '开通' },
  { action: 'expire', label: '转宽限' },
  { action: 'freeze', label: '冻结', danger: true },
  { action: 'resume', label: '恢复' },
  { action: 'terminate', label: '终止', danger: true },
  { action: 'dispose', label: '保留期处置', danger: true },
];

const STATUS_TAG: Record<string, string> = { pending: 'info', active: 'success', grace: 'warning', frozen: 'danger', terminated: 'danger' };

const loading = ref(false);
const tenantId = ref('');
const logs = ref<LifecycleLog[]>([]);
const currentStatus = ref<string | null>(null);

async function load(): Promise<void> {
  if (!tenantId.value) {
    ElMessage.warning('请输入租户 ID');
    return;
  }
  loading.value = true;
  try {
    logs.value = await saasApi.fetchLifecycleLogs(tenantId.value);
    currentStatus.value = logs.value.length > 0 ? logs.value[logs.value.length - 1].toStatus : null;
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    loading.value = false;
  }
}

async function onTransition(action: string): Promise<void> {
  try {
    await ElMessageBox.prompt(`对租户执行「${action}」，输入原因：`, '生命周期迁移', { type: 'warning', inputValue: '' });
  } catch {
    return;
  }
  try {
    const r = await saasApi.transitionLifecycle(tenantId.value, action);
    ElMessage.success(r.alreadyApplied ? '已处于目标状态（幂等，未重复记日志）' : `迁移成功：${r.from} → ${r.to}`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  }
}
</script>

<template>
  <div class="page">
    <el-card shadow="never" class="ops-card">
      <template #header><span>生命周期迁移</span></template>
      <el-form inline @submit.prevent="load">
        <el-form-item label="租户 ID">
          <el-input v-model="tenantId" placeholder="tenants.id" clearable style="width: 260px" @keyup.enter="load" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="loading" @click="load">加载历史</el-button>
        </el-form-item>
      </el-form>
      <el-form inline>
        <el-form-item>
          <el-button v-for="a in ACTIONS" :key="a.action" size="small" :type="a.danger ? 'danger' : 'primary'" plain :disabled="!tenantId" @click="onTransition(a.action)">
            {{ a.label }}
          </el-button>
        </el-form-item>
      </el-form>
      <el-alert v-if="currentStatus" :title="`当前状态：${currentStatus}`" :type="currentStatus === 'active' ? 'success' : 'warning'" :closable="false" />
    </el-card>

    <el-card shadow="never">
      <template #header><span>迁移历史</span></template>
      <el-table v-loading="loading" :data="logs" border>
        <el-table-column prop="createdAt" label="时间" width="180" />
        <el-table-column prop="action" label="动作" width="110" align="center" />
        <el-table-column label="迁移" width="170" align="center">
          <template #default="{ row }">{{ row.fromStatus ?? '∅' }} → {{ row.toStatus }}</template>
        </el-table-column>
        <el-table-column label="操作者" width="110" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.actorType === 'system' ? 'info' : 'primary'">{{ row.actorType }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="原因" min-width="200" show-overflow-tooltip />
        <el-table-column prop="requestId" label="requestId" width="160" show-overflow-tooltip />
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.ops-card {
  margin-bottom: 16px;
}
</style>

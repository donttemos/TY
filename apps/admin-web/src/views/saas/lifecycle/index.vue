<!--
 * @file 租户生命周期页（M13，PRD-013 §2.3 / ADR-0031；M14/PRD-014 FR-14-01/02/03 重构）
 * @description 按租户执行生命周期迁移：真实状态驱动（GET lifecycle/status，按钮按 allowedActions
 *   禁用，非法迁移 4030 由后端状态机兜底、重复执行幂等 alreadyApplied）+ 操作原因端到端透传
 *   （FR-14-01：prompt 返回值接收并传 API，落库 lifecycle_logs.reason）+ 写操作 v-permission
 *   （FR-14-02：ops:saas:write，只读角色不渲染动作行）+ 迁移历史（只增不改不删）。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-20 M14/PRD-014 B1 正确性修复：原因透传、真实状态驱动、权限渲染（U-14-1/2/3）。
 * @modified 2026-10-20 M14/PRD-014 B3：租户输入换 TenantPicker；原因收集统一走 confirmWithReason
 *   （危险动作必填，普通动作选填，FR-14-08）。
 * @module admin-web/views
-->

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import * as saasApi from '@/api/saas';
import type { LifecycleLog } from '@/api/types';
import TenantPicker from '@/components/TenantPicker/index.vue';
import { confirmWithReason } from '@/components/ConfirmWithReason';
import { BizError, describeBizError } from '@/utils/biz-error';

const ACTIONS: Array<{ action: string; label: string; danger?: boolean }> = [
  { action: 'activate', label: '开通' },
  { action: 'expire', label: '转宽限' },
  { action: 'freeze', label: '冻结', danger: true },
  { action: 'resume', label: '恢复' },
  { action: 'terminate', label: '终止', danger: true },
  { action: 'dispose', label: '保留期处置', danger: true },
];

const loading = ref(false);
const tenantId = ref('');
const logs = ref<LifecycleLog[]>([]);
/** 真实状态（store 直读，非日志推导）+ 合法动作集（后端迁移表派生） */
const statusInfo = ref<{ status: string | null; allowedActions: string[] } | null>(null);

function actionLabel(action: string): string {
  return ACTIONS.find((a) => a.action === action)?.label ?? action;
}

function isAllowed(action: string): boolean {
  return statusInfo.value?.allowedActions.includes(action) ?? false;
}

/** 禁用提示（title 属性；空串 = 不禁用） */
function disabledHint(action: string): string {
  if (!tenantId.value) return '请先输入租户 ID';
  if (!statusInfo.value) return '请先加载租户状态';
  if (statusInfo.value.status === null) return '未查询到租户状态，不可操作';
  if (!isAllowed(action)) return `当前状态「${statusInfo.value.status}」不允许该动作`;
  return '';
}

async function load(): Promise<void> {
  if (!tenantId.value) {
    ElMessage.warning('请输入租户 ID');
    return;
  }
  loading.value = true;
  try {
    const [status, logList] = await Promise.all([
      saasApi.fetchTenantLifecycleStatus(tenantId.value),
      saasApi.fetchLifecycleLogs(tenantId.value),
    ]);
    statusInfo.value = status;
    logs.value = logList;
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    loading.value = false;
  }
}

async function onTransition(action: string): Promise<void> {
  const danger = ACTIONS.find((a) => a.action === action)?.danger ?? false;
  // FR-14-08：原因收集统一走 confirmWithReason（危险动作必填，普通动作选填）
  const reason = await confirmWithReason({
    title: '生命周期迁移',
    message: `对租户执行「${actionLabel(action)}」`,
    required: danger,
    placeholder: danger ? '必填：说明操作依据（审计可追溯）' : '原因（可留空）',
  });
  if (reason === null) return; // 取消或必填未填 → 不执行
  try {
    const r = await saasApi.transitionLifecycle(tenantId.value, action, reason ?? undefined);
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
        <el-form-item label="租户">
          <TenantPicker v-model="tenantId" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="loading" @click="load">加载状态与历史</el-button>
        </el-form-item>
      </el-form>
      <el-form v-permission="'ops:saas:write'" inline>
        <el-form-item>
          <el-button
            v-for="a in ACTIONS"
            :key="a.action"
            size="small"
            :type="a.danger ? 'danger' : 'primary'"
            plain
            :disabled="!tenantId || !isAllowed(a.action)"
            :title="disabledHint(a.action)"
            @click="onTransition(a.action)"
          >
            {{ a.label }}
          </el-button>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="statusInfo && statusInfo.status"
        :closable="false"
        :type="statusInfo.status === 'active' ? 'success' : 'warning'"
        :title="`当前状态：${statusInfo.status}　允许动作：${statusInfo.allowedActions.map(actionLabel).join(' / ') || '无'}`"
      />
      <el-alert
        v-else-if="statusInfo"
        type="info"
        :closable="false"
        title="未查询到租户生命周期状态（租户不存在或尚未初始化），不可执行迁移"
      />
    </el-card>

    <el-card shadow="never">
      <template #header><span>迁移历史</span></template>
      <el-table v-loading="loading" :data="logs" border>
        <el-table-column prop="createdAt" label="时间" width="180" />
        <el-table-column prop="action" label="动作" width="110" align="center">
          <template #default="{ row }">{{ actionLabel(row.action) }}</template>
        </el-table-column>
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
      <el-empty v-if="!loading && logs.length === 0" description="无迁移历史（租户可能尚未发生任何状态变更）" :image-size="60" />
    </el-card>
  </div>
</template>

<style scoped>
.ops-card {
  margin-bottom: 16px;
}
</style>

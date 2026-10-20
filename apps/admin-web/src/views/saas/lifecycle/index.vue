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
 * @modified 2026-10-20 M14 跨页闭环：租户上下文取 useTenantQuery —— `/saas/lifecycle?tenantId=` 直达即
 *   自动加载状态与迁移历史（工作台「已冻结/已终止」跳转不再要求二次选择）；无参只复位不发请求。
 * @modified 2026-10-20 M14/PRD-014 FR-14-04（AC-14-04）：状态 + 历史接入 createRequestGuard
 *   （租户快照校验），切租户即复位并作废在途票据 —— 旧租户的迟到响应不得改写当前状态，
 *   否则按钮合法性（allowedActions）会按错误状态计算。
 * @module admin-web/views
-->

<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import * as saasApi from '@/api/saas';
import type { LifecycleLog } from '@/api/types';
import TenantPicker from '@/components/TenantPicker/index.vue';
import { confirmWithReason } from '@/components/ConfirmWithReason';
import { useTenantQuery } from '@/composables/useTenantQuery';
import { createRequestGuard } from '@/composables/useRequestGuard';
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
const logs = ref<LifecycleLog[]>([]);
/** 真实状态（store 直读，非日志推导）+ 合法动作集（后端迁移表派生） */
const statusInfo = ref<{ status: string | null; allowedActions: string[] } | null>(null);

/** 状态 + 历史来自同一次「加载」，共用一个守卫（两次请求由 Promise.all 同时发出） */
const guard = createRequestGuard();

/** 当前租户：由路由 `?tenantId=` 初始化（缺失 = 无租户态，不发起任何查询） */
const { tenantId } = useTenantQuery({
  onTenant: () => load(),
  onEmpty: () => resetTenantData(),
});

/** 清空当前租户的状态与迁移历史（不发请求：切换租户复位 / 路由参数缺失复位） */
function resetTenantData(): void {
  guard.invalidate();
  statusInfo.value = null;
  logs.value = [];
  // 作废后旧请求的 finally 不再关 loading，必须显式复位，否则「加载状态与历史」按钮永转
  loading.value = false;
}

// 租户一变即复位（sync：赋值瞬间执行，早于在途 promise 恢复），
// 避免「选择器已指向 B、页面仍是 A 的状态与历史」（FR-14-04 / AC-14-04）
watch(tenantId, () => resetTenantData(), { flush: 'sync' });

function actionLabel(action: string): string {
  return ACTIONS.find((a) => a.action === action)?.label ?? action;
}

function isAllowed(action: string): boolean {
  return statusInfo.value?.allowedActions.includes(action) ?? false;
}

/** 禁用提示（title 属性；空串 = 不禁用） */
function disabledHint(action: string): string {
  if (!tenantId.value) return '请先选择租户';
  if (!statusInfo.value) return '请先加载租户状态';
  if (statusInfo.value.status === null) return '未查询到租户状态，不可操作';
  if (!isAllowed(action)) return `当前状态「${statusInfo.value.status}」不允许该动作`;
  return '';
}

async function load(): Promise<void> {
  const tenant = tenantId.value;
  if (!tenant) {
    ElMessage.warning('请先选择租户');
    return;
  }
  const ticket = guard.begin(() => tenantId.value);
  loading.value = true;
  try {
    const [status, logList] = await Promise.all([
      saasApi.fetchTenantLifecycleStatus(tenant),
      saasApi.fetchLifecycleLogs(tenant),
    ]);
    // 旧租户的迟到响应不得改写当前状态（否则按钮合法性按错误状态计算）
    ticket.apply(() => {
      statusInfo.value = status;
      logs.value = logList;
    });
  } catch (e) {
    if (ticket.isFresh()) ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    if (ticket.isFresh()) loading.value = false;
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

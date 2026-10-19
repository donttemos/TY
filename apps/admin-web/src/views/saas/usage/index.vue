<!--
 * @file 用量看板页（M13，PRD-013 §2.3）
 * @description 生效配额列表（覆盖 ?? 套餐默认）+ 指定指标窗口用量（rollup 重算，进度条）、
 *   运营补录用量上报（hard 超限 4029 / 重复幂等键 deduped）。权限 ops:saas:read / write。
 * @author donttemo
 * @created 2026-10-19
 * @module admin-web/views
-->

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import * as saasApi from '@/api/saas';
import { BizError, describeBizError } from '@/utils/biz-error';

interface QuotaRow {
  quotaKey: string;
  limitValue: string;
  execution: string;
  source: string;
}

interface UsageRow {
  totalQuantity: string;
  eventCount: number;
  limitValue: string;
  execution: string;
  windowStart: string;
  windowEnd: string;
}

const loading = ref(false);
const tenantId = ref('');
const quotas = ref<QuotaRow[]>([]);
const usage = ref<UsageRow | null>(null);
const usageKey = ref('');
const reportForm = reactive({ quotaKey: 'api_calls', quantity: 1, idempotencyKey: '' });

function percent(used: string, limit: string): number {
  const l = Number(limit);
  if (!Number.isFinite(l) || l <= 0) return 0;
  return Math.min(100, Math.round((Number(used) / l) * 100));
}

async function loadQuotas(): Promise<void> {
  if (!tenantId.value) {
    ElMessage.warning('请输入租户 ID');
    return;
  }
  loading.value = true;
  try {
    quotas.value = await saasApi.fetchTenantQuotas(tenantId.value);
    if (quotas.value.length > 0 && !usageKey.value) {
      usageKey.value = quotas.value[0].quotaKey;
      await loadUsage();
    }
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    loading.value = false;
  }
}

async function loadUsage(): Promise<void> {
  if (!tenantId.value || !usageKey.value) return;
  try {
    usage.value = await saasApi.fetchTenantUsage(tenantId.value, usageKey.value);
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  }
}

async function onReport(): Promise<void> {
  if (!tenantId.value || !reportForm.quotaKey || !reportForm.quantity || reportForm.quantity <= 0) {
    ElMessage.warning('租户 ID / 指标键 / 正数量必填');
    return;
  }
  const key = reportForm.idempotencyKey || `ops:${Date.now()}`;
  try {
    const r = await saasApi.recordUsageEvent(tenantId.value, { quotaKey: reportForm.quotaKey, quantity: reportForm.quantity, idempotencyKey: key });
    ElMessage.success(r.result === 'deduped' ? '重复幂等键，未重复计量（deduped）' : `已扣减：used=${r.used} / limit=${r.limit}`);
    if (usageKey.value === reportForm.quotaKey) await loadUsage();
  } catch (e) {
    // 4029 配额超限：文案由错误码表给出（details 携带 metricKey/used/limit）
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  }
}
</script>

<template>
  <div class="page">
    <el-card shadow="never" class="query-card">
      <template #header><span>生效配额（覆盖 ?? 套餐默认）</span></template>
      <el-form inline @submit.prevent="loadQuotas">
        <el-form-item label="租户 ID">
          <el-input v-model="tenantId" placeholder="tenants.id" clearable style="width: 260px" @keyup.enter="loadQuotas" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="loading" @click="loadQuotas">查询</el-button>
        </el-form-item>
      </el-form>
      <el-table v-loading="loading" :data="quotas" border>
        <el-table-column prop="quotaKey" label="指标键" min-width="140" />
        <el-table-column prop="limitValue" label="生效限额" width="140" align="right" />
        <el-table-column prop="execution" label="执行方式" width="110" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.execution === 'hard' ? 'danger' : row.execution === 'soft' ? 'warning' : 'info'">{{ row.execution }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="source" label="来源" width="140" align="center" />
        <el-table-column label="操作" width="110" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click="usageKey = row.quotaKey; loadUsage()">看用量</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="query-card">
      <template #header><span>窗口用量（{{ usageKey || '未选择指标' }}）</span></template>
      <template v-if="usage">
        <el-progress :percentage="percent(usage.totalQuantity, usage.limitValue)" :status="percent(usage.totalQuantity, usage.limitValue) >= 100 ? 'exception' : undefined" />
        <el-descriptions :column="4" border class="usage-desc">
          <el-descriptions-item label="已用">{{ usage.totalQuantity }}</el-descriptions-item>
          <el-descriptions-item label="限额">{{ usage.limitValue }}</el-descriptions-item>
          <el-descriptions-item label="事件数">{{ usage.eventCount }}</el-descriptions-item>
          <el-descriptions-item label="窗口">{{ usage.windowStart.slice(0, 10) }}</el-descriptions-item>
        </el-descriptions>
      </template>
      <el-empty v-else description="查询后展示" :image-size="60" />
    </el-card>

    <el-card shadow="never">
      <template #header><span>用量上报（运营补录）</span></template>
      <el-form inline>
        <el-form-item label="指标键">
          <el-input v-model="reportForm.quotaKey" style="width: 160px" />
        </el-form-item>
        <el-form-item label="数量">
          <el-input-number v-model="reportForm.quantity" :min="1" style="width: 120px" />
        </el-form-item>
        <el-form-item label="幂等键">
          <el-input v-model="reportForm.idempotencyKey" placeholder="留空自动生成" style="width: 240px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :disabled="!tenantId" @click="onReport">上报</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.query-card {
  margin-bottom: 16px;
}
.usage-desc {
  margin-top: 12px;
}
</style>

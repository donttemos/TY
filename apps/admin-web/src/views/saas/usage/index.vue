<!--
 * @file 用量看板页（M13，PRD-013 §2.3；M14/PRD-014 FR-14-02/04 修复）
 * @description 生效配额列表（覆盖 ?? 套餐默认）+ 指定指标窗口用量（rollup 重算，进度条）、
 *   运营补录用量上报（hard 超限 4029 / 重复幂等键 deduped）。权限 ops:saas:read / write。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-20 M14/PRD-014 B1：切换租户即重置上一租户的配额/用量数据（U-14-6 残留缺陷）；
 *   上报按钮补 v-permission（U-14-2）。
 * @modified 2026-10-20 M14/PRD-014 B3：租户输入换 TenantPicker（FR-14-08/10 租户上下文）。
 * @modified 2026-10-20 M14/PRD-014 B4（FR-14-13）：新增用量趋势图（hours 白名单 + 纯 CSS 柱状，零新依赖）
 *   与事件明细分页表。
 * @modified 2026-10-20 M14 跨页闭环：租户上下文取 useTenantQuery —— `/saas/usage?tenantId=` 直达即自动
 *   拉配额/用量/趋势/明细（工作台「配额风险」跳转不再要求二次选择）；无参只复位不发请求。
 * @module admin-web/views
-->

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import * as saasApi from '@/api/saas';
import TenantPicker from '@/components/TenantPicker/index.vue';
import { useTenantQuery } from '@/composables/useTenantQuery';
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
/** 当前租户：由路由 `?tenantId=` 初始化（缺失 = 无租户态，不发起任何查询） */
const { tenantId } = useTenantQuery({
  onTenant: () => loadQuotas(),
  onEmpty: () => resetTenantData(),
});
/** 已加载租户（FR-14-04：切换租户即重置，防上一租户数据残留） */
const loadedTenant = ref('');
const quotas = ref<QuotaRow[]>([]);
const usage = ref<UsageRow | null>(null);
const usageKey = ref('');
const reportForm = reactive({ quotaKey: 'api_calls', quantity: 1, idempotencyKey: '' });

/** 清空当前租户的全部看板数据（不发请求：切换租户复位 / 路由参数缺失复位） */
function resetTenantData(): void {
  quotas.value = [];
  usage.value = null;
  usageKey.value = '';
  trend.value = [];
  events.value = [];
  eventTotal.value = 0;
  loadedTenant.value = '';
}

// 选择器清空（用户主动 / 路由撤参）：立即复位，避免空租户态下仍展示上一租户数据
watch(tenantId, (value) => {
  if (!value) resetTenantData();
});

function percent(used: string, limit: string): number {
  const l = Number(limit);
  if (!Number.isFinite(l) || l <= 0) return 0;
  return Math.min(100, Math.round((Number(used) / l) * 100));
}

async function loadQuotas(): Promise<void> {
  if (!tenantId.value) {
    ElMessage.warning('请先选择租户');
    return;
  }
  loading.value = true;
  try {
    if (loadedTenant.value !== tenantId.value) {
      resetTenantData();
      loadedTenant.value = tenantId.value;
    }
    quotas.value = await saasApi.fetchTenantQuotas(tenantId.value);
    if (quotas.value.length > 0 && !usageKey.value) {
      usageKey.value = quotas.value[0].quotaKey;
      await Promise.all([loadUsage(), loadTrend(), loadEvents()]);
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

// ---- 用量趋势（M14 FR-14-13：纯 CSS 柱状图，零新依赖） ----
const TREND_HOURS_OPTIONS = [
  { label: '24 小时', value: 24 },
  { label: '3 天', value: 72 },
  { label: '7 天', value: 168 },
  { label: '30 天', value: 720 },
];
const trendHours = ref(168);
const trendLoading = ref(false);
const trend = ref<Array<{ bucketStart: string; quantity: string; eventCount: number }>>([]);
const trendMax = computed(() => Math.max(1, ...trend.value.map((p) => Number(p.quantity))));

function bucketLabel(iso: string, hours: number): string {
  const d = new Date(iso);
  return hours <= 48
    ? `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:00`
    : `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

async function loadTrend(): Promise<void> {
  if (!tenantId.value || !usageKey.value) return;
  trendLoading.value = true;
  try {
    const r = await saasApi.fetchUsageTrend(tenantId.value, usageKey.value, trendHours.value);
    trend.value = r.points;
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    trendLoading.value = false;
  }
}

// ---- 事件明细（M14 FR-14-13：内存分页由后端提供） ----
const eventPage = ref(1);
const eventPageSize = ref(20);
const eventTotal = ref(0);
const events = ref<Array<{ quotaKey: string; quantity: string; occurredAt: string }>>([]);
const eventsLoading = ref(false);

async function loadEvents(): Promise<void> {
  if (!tenantId.value || !usageKey.value) return;
  eventsLoading.value = true;
  try {
    const r = await saasApi.fetchUsageEventList(tenantId.value, { quotaKey: usageKey.value, hours: trendHours.value, page: eventPage.value, pageSize: eventPageSize.value });
    events.value = r.items;
    eventTotal.value = r.total;
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    eventsLoading.value = false;
  }
}

/** 切换指标/租户/时间范围时一并刷新趋势与明细 */
async function switchMetric(key: string): Promise<void> {
  usageKey.value = key;
  await Promise.all([loadUsage(), loadTrend(), loadEvents()]);
}

async function onReport(): Promise<void> {
  if (!tenantId.value || !reportForm.quotaKey || !reportForm.quantity || reportForm.quantity <= 0) {
    ElMessage.warning('租户 / 指标键 / 正数量必填');
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
        <el-form-item label="租户">
          <TenantPicker v-model="tenantId" />
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
            <el-button link type="primary" @click="switchMetric(row.quotaKey)">看用量与趋势</el-button>
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

    <el-card shadow="never" class="query-card">
      <template #header>
        <div class="card-header">
          <span>用量趋势（{{ usageKey || '未选择指标' }}）</span>
          <el-radio-group v-model="trendHours" size="small" @change="loadTrend(); loadEvents()">
            <el-radio-button v-for="o in TREND_HOURS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <div v-loading="trendLoading" class="trend-box">
        <div v-for="p in trend" :key="p.bucketStart" class="trend-bar" :title="`${bucketLabel(p.bucketStart, trendHours)}｜${p.quantity}（${p.eventCount} 次）`">
          <div class="trend-bar-inner" :style="{ height: `${Math.max(2, (Number(p.quantity) / trendMax) * 100)}%` }" />
        </div>
        <el-empty v-if="trend.length === 0" description="查询后展示趋势（后端按 UTC 桶聚合，含零桶）" :image-size="48" />
      </div>
    </el-card>

    <el-card shadow="never" class="query-card">
      <template #header><span>事件明细（{{ usageKey || '未选择指标' }}，最近 {{ TREND_HOURS_OPTIONS.find((o) => o.value === trendHours)?.label ?? trendHours }}）</span></template>
      <el-table v-loading="eventsLoading" :data="events" border>
        <el-table-column prop="occurredAt" label="发生时间" min-width="200" />
        <el-table-column prop="quotaKey" label="指标键" min-width="140" />
        <el-table-column prop="quantity" label="数量" width="140" align="right" />
      </el-table>
      <el-empty v-if="!eventsLoading && events.length === 0" description="窗口内无用量事件" :image-size="48" />
      <el-pagination
        v-model:current-page="eventPage"
        v-model:page-size="eventPageSize"
        :total="eventTotal"
        :page-sizes="[20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        class="pager"
        @current-change="loadEvents()"
        @size-change="eventPage = 1; loadEvents()"
      />
    </el-card>

    <el-card shadow="never" class="query-card">
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
          <el-button v-permission="'ops:saas:write'" type="primary" :disabled="!tenantId" @click="onReport">上报</el-button>
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
.trend-box {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 160px;
  padding-top: 8px;
}
.trend-bar {
  flex: 1;
  min-width: 4px;
  max-width: 24px;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.trend-bar-inner {
  width: 100%;
  background-color: var(--el-color-primary);
  border-radius: 2px 2px 0 0;
  min-height: 2px;
  transition: height 0.2s;
}
.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>

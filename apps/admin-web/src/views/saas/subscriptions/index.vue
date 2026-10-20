<!--
 * @file 订阅管理页（M13 PRD-013 §2.3；M14/PRD-014 FR-14-10 产品化重构）
 * @description 全局订阅列表（租户/套餐/状态筛选 + 分页 + planCode/planName/planVersion 补全展示）→
 *   详情抽屉（当前订阅 + 该租户订阅历史）→ 开通（TenantPicker + 套餐下拉，一租户一生效 1003 提示）/
 *   取消（confirmWithReason 统一原因收集，端到端落库）。写操作 v-permission ops:saas:write。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-20 M14 B3：从「单租户手输 ID 查询面板」升级为运营列表优先视图（U-14-5）；
 *   取消原因走 confirmWithReason 统一入口（U-14-1 收口）。
 * @modified 2026-10-20 M14 跨页闭环：租户筛选取 useTenantQuery —— `/saas/subscriptions?tenantId=` 直达
 *   即按该租户自动筛选（工作台「即将到期订阅」跳转不再要求二次选择），前进/后退同步跟随。
 * @module admin-web/views
-->

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import * as saasApi from '@/api/saas';
import type { SubscriptionRow } from '@/api/saas';
import TenantPicker from '@/components/TenantPicker/index.vue';
import { confirmWithReason } from '@/components/ConfirmWithReason';
import { useTenantQuery } from '@/composables/useTenantQuery';
import { BizError, describeBizError } from '@/utils/biz-error';

const STATUS_TAG: Record<string, 'success' | 'warning' | 'info' | 'danger'> = { active: 'success', expired: 'warning', cancelled: 'info' };

// ---- 全局订阅列表 ----
const loading = ref(false);
/** 租户筛选：由路由 `?tenantId=` 初始化；参数缺失 = 全局列表（不会拼出空租户查询） */
const { tenantId } = useTenantQuery({
  onTenant: () => loadList(true),
  onEmpty: () => loadList(true),
});
const filters = reactive({ planCode: '', status: '' });
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const rows = ref<SubscriptionRow[]>([]);

async function loadList(resetPage = false): Promise<void> {
  if (resetPage) page.value = 1;
  loading.value = true;
  try {
    const r = await saasApi.fetchSubscriptions({
      page: page.value,
      pageSize: pageSize.value,
      tenantId: tenantId.value || undefined,
      planCode: filters.planCode || undefined,
      status: filters.status || undefined,
    });
    rows.value = r.items;
    total.value = r.total;
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    loading.value = false;
  }
}

function resetFilters(): void {
  tenantId.value = '';
  filters.planCode = '';
  filters.status = '';
  void loadList(true);
}

// ---- 详情抽屉（当前订阅 + 租户订阅历史） ----
const drawerVisible = ref(false);
const detailRow = ref<SubscriptionRow | null>(null);
const history = ref<SubscriptionRow[]>([]);
const historyLoading = ref(false);

async function openDetail(row: SubscriptionRow): Promise<void> {
  detailRow.value = row;
  drawerVisible.value = true;
  historyLoading.value = true;
  try {
    history.value = await saasApi.fetchTenantSubscriptionHistory(row.tenantId);
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    historyLoading.value = false;
  }
}

// ---- 开通订阅 ----
const plans = ref<Array<{ id: string; code: string; name: string }>>([]);
const createForm = reactive({ tenantId: '', planCode: '', planVersion: undefined as number | undefined, expireAt: '' });
const creating = ref(false);

async function onCreate(): Promise<void> {
  if (!createForm.tenantId || !createForm.planCode) {
    ElMessage.warning('租户与套餐必选');
    return;
  }
  const note = await confirmWithReason({ title: '开通订阅', message: `为所选租户开通「${createForm.planCode}」订阅？`, placeholder: '开通说明（可留空）' });
  if (note === null) return; // 用户取消
  creating.value = true;
  try {
    await saasApi.createSubscription({
      tenantId: createForm.tenantId,
      planCode: createForm.planCode,
      planVersion: createForm.planVersion,
      expireAt: createForm.expireAt || undefined,
    });
    ElMessage.success('订阅已开通（版本快照已生成）');
    createForm.tenantId = '';
    createForm.planVersion = undefined;
    createForm.expireAt = '';
    await loadList(true);
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    creating.value = false;
  }
}

// ---- 取消订阅 ----
const cancellingId = ref('');

async function onCancel(row: SubscriptionRow): Promise<void> {
  const reason = await confirmWithReason({ title: '取消订阅', message: '确认取消该租户的生效订阅？', placeholder: '填写取消原因，便于审计追溯' });
  if (reason === null) return; // 取消 → 不执行（确认且留空 → undefined，仍执行）
  cancellingId.value = row.id;
  try {
    await saasApi.cancelSubscription(row.id, reason ?? undefined);
    ElMessage.success('订阅已取消');
    const refreshDetail = detailRow.value?.tenantId === row.tenantId ? openDetail(row) : Promise.resolve();
    await Promise.all([loadList(), refreshDetail]);
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    cancellingId.value = '';
  }
}

async function loadPlans(): Promise<void> {
  try {
    plans.value = await saasApi.fetchPlans();
    if (!createForm.planCode && plans.value.length > 0) createForm.planCode = plans.value[0].code;
  } catch {
    // 套餐下拉失败不阻断列表（B2 起后端校验 code 存在性）
  }
}

onMounted(() => {
  // 列表首屏统一由 useTenantQuery 触发（带参按租户筛选、无参为全局列表），此处不再重复取数
  void loadPlans();
});
</script>

<template>
  <div class="page">
    <el-card shadow="never" class="toolbar-card">
      <template #header>
        <div class="card-header">
          <span>订阅列表</span>
          <el-button size="small" @click="resetFilters">重置</el-button>
        </div>
      </template>
      <el-form inline @submit.prevent="loadList(true)">
        <el-form-item label="租户">
          <TenantPicker v-model="tenantId" @update:model-value="loadList(true)" />
        </el-form-item>
        <el-form-item label="套餐编码">
          <el-input v-model="filters.planCode" placeholder="如 default" clearable style="width: 160px" @keyup.enter="loadList(true)" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 140px" @change="loadList(true)">
            <el-option label="生效中" value="active" />
            <el-option label="已到期" value="expired" />
            <el-option label="已取消" value="cancelled" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="loading" @click="loadList(true)">查询</el-button>
        </el-form-item>
      </el-form>
      <el-table v-loading="loading" :data="rows" border>
        <el-table-column prop="tenantId" label="租户 ID" min-width="200" show-overflow-tooltip />
        <el-table-column label="套餐" min-width="180">
          <template #default="{ row }">
            {{ row.planCode ?? '—' }}<el-tag v-if="row.planVersion" size="small" class="ver-tag">v{{ row.planVersion }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="STATUS_TAG[row.status] ?? 'info'">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="effectiveAt" label="生效时间" width="180" />
        <el-table-column label="到期时间" width="180">
          <template #default="{ row }">{{ row.expireAt ?? '无期限' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button
              v-if="row.status === 'active'"
              v-permission="'ops:saas:write'"
              link
              type="danger"
              :loading="cancellingId === row.id"
              @click="onCancel(row)"
            >
              取消
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        class="pager"
        @current-change="loadList()"
        @size-change="loadList(true)"
      />
    </el-card>

    <el-card v-permission="'ops:saas:write'" shadow="never" class="toolbar-card">
      <template #header><span>开通订阅</span></template>
      <el-form inline>
        <el-form-item label="租户">
          <TenantPicker v-model="createForm.tenantId" />
        </el-form-item>
        <el-form-item label="套餐">
          <el-select v-model="createForm.planCode" style="width: 180px" placeholder="选择套餐">
            <el-option v-for="p in plans" :key="p.id" :value="p.code" :label="`${p.name}（${p.code}）`" />
          </el-select>
        </el-form-item>
        <el-form-item label="绑定版本">
          <el-input-number v-model="createForm.planVersion" :min="1" placeholder="最新" style="width: 120px" />
        </el-form-item>
        <el-form-item label="到期时间">
          <el-date-picker v-model="createForm.expireAt" type="date" value-format="YYYY-MM-DD" placeholder="可留空（无期限）" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="creating" @click="onCreate">开通</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-drawer v-model="drawerVisible" :title="`订阅详情：${detailRow?.tenantId ?? ''}`" size="55%">
      <template v-if="detailRow">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="订阅 ID">{{ detailRow.id }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="STATUS_TAG[detailRow.status] ?? 'info'">{{ detailRow.status }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="套餐">{{ detailRow.planCode ?? '—' }}<el-tag v-if="detailRow.planVersion" size="small" class="ver-tag">v{{ detailRow.planVersion }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="套餐名称">{{ detailRow.planName ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="生效时间">{{ detailRow.effectiveAt }}</el-descriptions-item>
          <el-descriptions-item label="到期时间">{{ detailRow.expireAt ?? '无期限' }}</el-descriptions-item>
          <el-descriptions-item label="关闭时间">{{ detailRow.closedAt ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="关闭原因">{{ detailRow.reason ?? '—' }}</el-descriptions-item>
        </el-descriptions>
        <h4 class="history-title">该租户订阅历史</h4>
        <el-table v-loading="historyLoading" :data="history" border>
          <el-table-column prop="id" label="订阅 ID" min-width="200" show-overflow-tooltip />
          <el-table-column label="套餐" width="130">
            <template #default="{ row }">{{ row.planCode ?? '—' }}<el-tag v-if="row.planVersion" size="small" class="ver-tag">v{{ row.planVersion }}</el-tag></template>
          </el-table-column>
          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="STATUS_TAG[row.status] ?? 'info'">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="effectiveAt" label="生效" width="170" />
          <el-table-column label="到期" width="170">
            <template #default="{ row }">{{ row.expireAt ?? '无期限' }}</template>
          </el-table-column>
          <el-table-column prop="reason" label="关闭原因" min-width="140" show-overflow-tooltip />
        </el-table>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.toolbar-card {
  margin-bottom: 16px;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
.ver-tag {
  margin-left: 4px;
}
.history-title {
  margin: 16px 0 8px;
}
</style>

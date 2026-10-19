<!--
 * @file 套餐管理页（M13 PRD-013 §2.3；M14/PRD-014 FR-14-09 产品化升级）
 * @description 套餐列表 → 新建套餐（FormDialog，code 唯一 1003 前端提示）→ 版本抽屉（历史版本只读 +
 *   版本配额默认项）→ 发布新版本（复制上一版本为起点 → 行级编辑 → 差异预览 → 确认发布；
 *   发布后不可变语义由后端保证，前端不提供修改已发布版本入口——AC-14-05）。写操作 v-permission。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-20 M14 B3（FR-14-05/06/09）：新建套餐、发布新版本全流程上管理端（B2 端点闭环），
 *   差异预览（added/removed/changed），去掉「发布走脚本」留白标注。
 * @module admin-web/views
-->

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import * as saasApi from '@/api/saas';
import type { PlanView } from '@/api/types';
import FormDialog from '@/components/FormDialog/index.vue';
import type { FormField, FormModel } from '@/components/CrudTable/types';
import { BizError, describeBizError } from '@/utils/biz-error';

const loading = ref(false);
const plans = ref<PlanView[]>([]);

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

// ---- 新建套餐（FormDialog 复用） ----
const createVisible = ref(false);
const creating = ref(false);
const createModel = reactive<FormModel>({ code: '', name: '', description: '' });
const createFields: FormField[] = [
  { prop: 'code', label: '套餐编码', type: 'input', placeholder: '唯一，如 professional', rules: [{ required: true, message: '套餐编码必填' }] },
  { prop: 'name', label: '套餐名称', type: 'input', placeholder: '如 专业版', rules: [{ required: true, message: '套餐名称必填' }] },
  { prop: 'description', label: '描述', type: 'textarea', span: 24, placeholder: '选填' },
];

function openCreate(): void {
  createModel.code = '';
  createModel.name = '';
  createModel.description = '';
  createVisible.value = true;
}

async function onCreateSubmit(model: FormModel): Promise<void> {
  creating.value = true;
  try {
    // FormDialog 契约：提交携带校验通过的 model（本页仅创建场景，直接使用 payload）
    await saasApi.createPlan({
      code: String(model.code ?? '').trim(),
      name: String(model.name ?? '').trim(),
      description: model.description ? String(model.description).trim() || null : null,
    });
    ElMessage.success('套餐已创建（进入版本抽屉发布首个版本）');
    createVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    creating.value = false;
  }
}

// ---- 版本抽屉 ----
const drawerVisible = ref(false);
const currentPlan = ref<PlanView | null>(null);
const versions = ref<Array<{ id: string; version: number; status: string; remark: string | null; publishedAt: string | null; quotas: Array<{ quotaKey: string; limitValue: string; execution: string | null }> }>>([]);
const versionsLoading = ref(false);

async function openVersions(plan: PlanView): Promise<void> {
  currentPlan.value = plan;
  drawerVisible.value = true;
  await reloadVersions();
}

async function reloadVersions(): Promise<void> {
  if (!currentPlan.value) return;
  versionsLoading.value = true;
  try {
    versions.value = await saasApi.fetchPlanVersions(currentPlan.value.id);
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    versionsLoading.value = false;
  }
}

// ---- 发布新版本（复制上一版本为起点 → 行级编辑 → 差异预览 → 确认） ----
interface QuotaDraftRow {
  quotaKey: string;
  limitValue: number;
  execution: '' | 'soft' | 'hard' | 'observe';
}
const publishVisible = ref(false);
const publishing = ref(false);
const publishRemark = ref('');
const draftRows = ref<QuotaDraftRow[]>([]);
/** 起点快照（差异基准 = 发布对话框打开时的最新版本；空 = 首个版本全量新增） */
const baseRows = ref<QuotaDraftRow[]>([]);

function draftOf(r: { quotaKey: string; limitValue: string; execution: string | null }): QuotaDraftRow {
  return { quotaKey: r.quotaKey, limitValue: Number(r.limitValue), execution: (r.execution as QuotaDraftRow['execution']) ?? '' };
}

async function openPublish(): Promise<void> {
  if (!currentPlan.value) return;
  const published = versions.value.filter((v) => v.status === 'published').sort((a, b) => b.version - a.version)[0];
  if (published) {
    baseRows.value = published.quotas.map(draftOf);
    draftRows.value = published.quotas.map(draftOf); // 复制上一版本为起点（FR-14-09）
  } else {
    baseRows.value = [];
    draftRows.value = [{ quotaKey: 'api_calls', limitValue: 100, execution: 'hard' }]; // 首个版本默认行
  }
  publishRemark.value = '';
  publishVisible.value = true;
}

function addDraftRow(): void {
  draftRows.value.push({ quotaKey: '', limitValue: 1, execution: '' });
}

function removeDraftRow(index: number): void {
  draftRows.value.splice(index, 1);
}

const diffRows = computed(() => {
  const base = new Map(baseRows.value.filter((r) => r.quotaKey).map((r) => [r.quotaKey, r]));
  const cur = new Map(draftRows.value.filter((r) => r.quotaKey.trim()).map((r) => [r.quotaKey.trim(), r]));
  const out: Array<{ quotaKey: string; type: 'added' | 'removed' | 'changed'; from: string; to: string }> = [];
  for (const [k, c] of cur) {
    const b = base.get(k);
    if (!b) out.push({ quotaKey: k, type: 'added', from: '—', to: `${c.limitValue}（${c.execution || '默认'}）` });
    else if (b.limitValue !== c.limitValue || b.execution !== c.execution)
      out.push({ quotaKey: k, type: 'changed', from: `${b.limitValue}（${b.execution || '默认'}）`, to: `${c.limitValue}（${c.execution || '默认'}）` });
  }
  for (const [k, b] of base) if (!cur.has(k)) out.push({ quotaKey: k, type: 'removed', from: `${b.limitValue}（${b.execution || '默认'}）`, to: '—' });
  return out.sort((x, y) => x.type.localeCompare(y.type));
});

const DIFF_TAG: Record<string, 'success' | 'danger' | 'warning'> = { added: 'success', removed: 'danger', changed: 'warning' };
const DIFF_LABEL: Record<string, string> = { added: '新增', removed: '移除', changed: '修改' };

async function onPublish(): Promise<void> {
  if (!currentPlan.value) return;
  const quotas = draftRows.value.filter((r) => r.quotaKey.trim());
  if (quotas.length === 0) {
    ElMessage.warning('版本必须至少包含一条配额定义');
    return;
  }
  if (draftRows.value.some((r) => r.quotaKey.trim() && (!Number.isFinite(r.limitValue) || r.limitValue < 0))) {
    ElMessage.warning('配额限额必须为非负数字');
    return;
  }
  publishing.value = true;
  try {
    await saasApi.publishPlanVersion(currentPlan.value.id, {
      remark: publishRemark.value || null,
      quotas: quotas.map((r) => ({ quotaKey: r.quotaKey.trim(), limitValue: r.limitValue, execution: r.execution || null })),
    });
    ElMessage.success('新版本已发布（历史版本与既有订阅快照不受影响）');
    publishVisible.value = false;
    await reloadVersions();
  } catch (e) {
    ElMessage.error(e instanceof BizError ? describeBizError(e) : '操作失败，请重试');
  } finally {
    publishing.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>套餐管理</span>
          <div>
            <el-button v-permission="'ops:saas:write'" type="primary" size="small" @click="openCreate">新建套餐</el-button>
            <el-button size="small" @click="load">刷新</el-button>
          </div>
        </div>
      </template>
      <el-table v-loading="loading" :data="plans" border>
        <el-table-column prop="code" label="编码" min-width="140" />
        <el-table-column prop="name" label="名称" min-width="140" />
        <el-table-column prop="description" label="描述" min-width="220" show-overflow-tooltip />
        <el-table-column label="操作" width="140" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click="openVersions(row)">版本与配额</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <FormDialog
      v-model:visible="createVisible"
      title="新建套餐"
      :fields="createFields"
      :model="createModel"
      :submitting="creating"
      mode="create"
      @submit="onCreateSubmit"
    />

    <el-drawer v-model="drawerVisible" :title="`版本与配额：${currentPlan?.name ?? ''}`" size="62%">
      <div class="drawer-toolbar">
        <el-alert
          type="info"
          :closable="false"
          title="已发布版本不可变：修改配额请发布新版本（既有订阅绑定的版本快照不受影响）"
        />
        <el-button v-permission="'ops:saas:write'" type="primary" size="small" :disabled="versionsLoading" @click="openPublish">
          发布新版本
        </el-button>
      </div>
      <el-table v-loading="versionsLoading" :data="versions" border>
        <el-table-column prop="version" label="版本" width="80" align="center" />
        <el-table-column prop="status" label="状态" width="110" align="center" />
        <el-table-column prop="publishedAt" label="发布时间" width="180" />
        <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip />
        <el-table-column label="配额默认项" min-width="300">
          <template #default="{ row }">
            <el-tag v-for="q in row.quotas" :key="q.quotaKey" class="quota-tag" size="small">
              {{ q.quotaKey }} ≤ {{ q.limitValue }}（{{ q.execution ?? '默认' }}）
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-drawer>

    <el-dialog v-model="publishVisible" title="发布新版本" width="720px" :close-on-click-modal="false">
      <el-alert type="warning" :closable="false" title="发布后版本不可变；预览确认差异后再提交。" class="publish-alert" />
      <el-form inline>
        <el-form-item label="版本备注">
          <el-input v-model="publishRemark" placeholder="选填，如 上调 API 限额" style="width: 280px" />
        </el-form-item>
      </el-form>
      <el-table :data="draftRows" border size="small">
        <el-table-column label="指标键" min-width="160">
          <template #default="{ row, $index }">
            <el-input v-model="row.quotaKey" placeholder="quotaKey" :disabled="publishing" />
          </template>
        </el-table-column>
        <el-table-column label="限额" width="160">
          <template #default="{ row }">
            <el-input-number v-model="row.limitValue" :min="0" :disabled="publishing" style="width: 130px" />
          </template>
        </el-table-column>
        <el-table-column label="执行方式" width="150">
          <template #default="{ row }">
            <el-select v-model="row.execution" :disabled="publishing" style="width: 120px" placeholder="默认">
              <el-option label="hard（硬限额）" value="hard" />
              <el-option label="soft（软限额）" value="soft" />
              <el-option label="observe（仅统计）" value="observe" />
              <el-option label="默认（hard）" value="" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" align="center">
          <template #default="{ $index }">
            <el-button link type="danger" :disabled="publishing" @click="removeDraftRow($index)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-button size="small" class="add-row" :disabled="publishing" @click="addDraftRow">+ 添加配额项</el-button>

      <h4 class="diff-title">与当前版本的差异预览</h4>
      <el-table v-if="diffRows.length > 0" :data="diffRows" border size="small">
        <el-table-column label="类型" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="DIFF_TAG[row.type]">{{ DIFF_LABEL[row.type] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="quotaKey" label="指标键" min-width="140" />
        <el-table-column prop="from" label="变更前" min-width="160" />
        <el-table-column prop="to" label="变更后" min-width="160" />
      </el-table>
      <el-empty v-else description="与起点版本无差异（仍可发布用于留痕）" :image-size="48" />

      <template #footer>
        <el-button @click="publishVisible = false">取消</el-button>
        <el-button type="primary" :loading="publishing" @click="onPublish">确认发布</el-button>
      </template>
    </el-dialog>
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
.drawer-toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}
.publish-alert {
  margin-bottom: 12px;
}
.add-row {
  margin-top: 8px;
}
.diff-title {
  margin: 16px 0 8px;
}
</style>

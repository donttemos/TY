<!--
 * @file 租户管理页（N-01）
 * @description 平台管理员视角的租户生命周期维护：列表（编码 / 名称 / 隔离级别 / 套餐 / 状态 / 到期时间，
 *   隔离级别与状态用 StatusTag + 字典 tenant_isolation / tenant_status）、开租户（选 isolation，dedicated
 *   必须带独立库连接串）、改套餐与状态（编辑弹窗）、停用（DELETE，不物理删——租户解析仍按 code 命中并给
 *   4001，故确认文案与「删除」刻意区分，走 actions-extra 自定义而非内置删除按钮）、隔离级别迁移
 *   （tenant:manage，长任务：立即返回 jobId，进度由全局任务条 JobBar 承载）。
 *   权限：tenant:read / create / update / delete / manage；无 tenant:read 时菜单不出现、直输 URL 落 403。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/views
-->

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import CrudTable from '@/components/CrudTable/index.vue';
import StatusTag from '@/components/StatusTag/index.vue';
import * as tenantApi from '@/api/tenant';
import { useJobCenterStore } from '@/composables/useJobCenter';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { CrudColumn, FormField, SearchField } from '@/components/CrudTable/types';
import type { TenantIsolation, TenantView } from '@/api/types';

const crudRef = ref<InstanceType<typeof CrudTable>>();

const columns: CrudColumn[] = [
  { prop: 'code', label: '编码', minWidth: 120, sortable: true },
  { prop: 'name', label: '名称', minWidth: 140, sortable: true },
  { prop: 'isolation', label: '隔离级别', width: 170, align: 'center', slot: 'isolation', sortable: true },
  { prop: 'plan', label: '套餐', width: 100 },
  { prop: 'status', label: '状态', width: 90, align: 'center', slot: 'status', sortable: true },
  { prop: 'expireAt', label: '到期时间', width: 120, slot: 'expireAt', sortable: true },
  { prop: 'createdAt', label: '创建时间', width: 180, slot: 'createdAt', sortable: true },
];

const searchForm: SearchField[] = [
  { prop: 'keyword', label: '关键字', type: 'input', placeholder: '编码 / 名称' },
  { prop: 'isolation', label: '隔离级别', type: 'select', dictCode: 'tenant_isolation' },
  { prop: 'status', label: '状态', type: 'select', dictCode: 'tenant_status' },
];

/**
 * 表单字段：code / isolation 创建后不可改（code 是解析键、isolation 一律走 migrate），
 * 编辑弹窗通过 CrudTable 的「详情拉取失败回退行数据」机制取值（租户无独立详情端点，列表项即视图）。
 * dbUrl 仅创建时可填：dedicated 必填（服务端强校验），shared 填了会被 400 拒绝（不留「切回共享库但密文还在」的错觉）。
 */
const formFields: FormField[] = [
  { prop: 'code', label: '编码', type: 'input', disabledOnEdit: true, rules: [{ required: true, message: '请输入租户编码', trigger: 'blur' }] },
  { prop: 'name', label: '名称', type: 'input', rules: [{ required: true, message: '请输入租户名称', trigger: 'blur' }] },
  {
    prop: 'isolation',
    label: '隔离级别',
    type: 'radio',
    disabledOnEdit: true,
    options: [
      { label: '共享库（shared）', value: 'shared' },
      { label: '独立库（dedicated）', value: 'dedicated' },
    ],
  },
  { prop: 'plan', label: '套餐', type: 'input', placeholder: '如 basic / pro，可留空' },
  { prop: 'expireAt', label: '到期时间', type: 'date' },
  {
    prop: 'dbUrl',
    label: '独立库连接串',
    type: 'textarea',
    hiddenOnEdit: true,
    placeholder: '仅 dedicated 必填，如 postgresql://…（明文提交，服务端加密落库）；shared 留空',
  },
];

/** ---------- 停用（DELETE = freeze，不物理删；确认文案必须与删除语义区分） ---------- */
async function handleDisable(row: TenantView): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认停用租户「${row.name}（${row.code}）」？停用 = 冻结（freeze）：该租户业务访问将被拒绝（4031），登录白名单面仍可达，数据保留、可随时重新启用。`,
      '停用租户',
      { type: 'warning', confirmButtonText: '确认停用', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await tenantApi.disableTenant(row.id);
    ElMessage.success('租户已停用');
    crudRef.value?.refresh();
  } catch (err) {
    // legacy 租户（存量单租户）停用会被服务端 3003 拒绝，原因会直接展示
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '停用失败，请重试');
  }
}

/** ---------- 启用（PUT status=1 → 控制器转 resume；frozen 唯一出口） ---------- */
async function handleEnable(row: TenantView): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认启用租户「${row.name}（${row.code}）」？恢复后该租户业务访问即时放行。`, '启用租户', {
      type: 'warning',
      confirmButtonText: '确认启用',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  try {
    await tenantApi.updateTenant(row.id, { status: 1 });
    ElMessage.success('租户已启用');
    crudRef.value?.refresh();
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '启用失败，请重试');
  }
}

/** ---------- 隔离级别迁移（长任务 → 任务条） ---------- */
const jobCenter = useJobCenterStore();
const migrateDialog = ref(false);
const migrateSubmitting = ref(false);
const migrateTarget = ref<TenantView | null>(null);
const migrateForm = reactive<{ isolation: TenantIsolation; dbUrl: string }>({ isolation: 'shared', dbUrl: '' });

function openMigrate(row: TenantView): void {
  migrateTarget.value = row;
  // 默认勾选「另一侧」：迁移语义是从当前级别切走
  migrateForm.isolation = row.isolation === 'shared' ? 'dedicated' : 'shared';
  migrateForm.dbUrl = '';
  migrateDialog.value = true;
}

async function submitMigrate(): Promise<void> {
  const target = migrateTarget.value;
  if (!target) return;
  if (migrateForm.isolation === 'dedicated' && !migrateForm.dbUrl.trim()) {
    ElMessage.warning('迁移到 dedicated 必须提供独立库连接串');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认将租户「${target.name}」迁移至${migrateForm.isolation === 'dedicated' ? '独立库' : '共享库'}？` +
        '迁移为控制面切换（隔离级别与连接串），历史数据的物理搬迁需运维按部署手册执行，不在本操作内完成。',
      '迁移隔离级别',
      { type: 'warning', confirmButtonText: '确认迁移', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  migrateSubmitting.value = true;
  try {
    const job = await tenantApi.migrateTenant(target.id, {
      isolation: migrateForm.isolation,
      ...(migrateForm.isolation === 'dedicated' ? { dbUrl: migrateForm.dbUrl.trim() } : {}),
    });
    jobCenter.track(job);
    ElMessage.success('迁移任务已派发，可在底部任务条查看进度');
    migrateDialog.value = false;
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '迁移任务派发失败，请重试');
  } finally {
    migrateSubmitting.value = false;
  }
}

/** ---------- 展示辅助 ---------- */
function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <div class="fw-page">
    <!--
      hideDelete：DELETE /tenants/:id 的语义是「停用」（不物理删），内置删除按钮的
      「删除后不可恢复」确认文案会造成误导，改由 actions-extra 提供停用按钮。
      permission="tenant" → 新建/编辑按 tenant:create / tenant:update 判权。
    -->
    <CrudTable
      ref="crudRef"
      api="/tenants"
      :columns="columns"
      :search-form="searchForm"
      :form-fields="formFields"
      :form-defaults="{ isolation: 'shared' }"
      permission="tenant"
      hide-delete
      create-title="开租户"
      edit-title="编辑租户「{id}」"
      dialog-width="560px"
    >
      <template #cell-isolation="{ row }">
        <span class="fw-tenant-iso">
          <status-tag :value="row.isolation" dict-code="tenant_isolation" />
          <el-tag v-if="row.dedicatedDbConfigured" size="small" type="info" effect="plain">已配独立库</el-tag>
        </span>
      </template>
      <template #cell-status="{ row }">
        <status-tag :value="row.status" dict-code="tenant_status" />
      </template>
      <template #cell-expireAt="{ row }">
        {{ row.expireAt ? row.expireAt.slice(0, 10) : '长期' }}
      </template>
      <template #cell-createdAt="{ row }">
        {{ formatTime(row.createdAt) }}
      </template>
      <template #actions-extra="{ row }">
        <!-- 停用 = freeze：仅 active(1)/grace(2) 为合法源；frozen/terminated/pending 不给入口（4030 无意义点击） -->
        <el-button v-if="row.status === 1 || row.status === 2" v-permission="'tenant:delete'" link type="danger" @click="handleDisable(row as TenantView)">
          停用
        </el-button>
        <!-- 启用 = resume：仅 frozen(3) 有出口（terminated 不可复活、pending 走开通激活） -->
        <el-button v-if="row.status === 3" v-permission="'tenant:update'" link type="success" @click="handleEnable(row as TenantView)">
          启用
        </el-button>
        <el-button v-permission="'tenant:manage'" link type="warning" @click="openMigrate(row as TenantView)">迁移</el-button>
      </template>
    </CrudTable>

    <!-- 隔离级别迁移：长任务派发（进度走全局任务条） -->
    <el-dialog v-model="migrateDialog" title="迁移隔离级别" width="520px">
      <template v-if="migrateTarget">
        <el-alert
          type="warning"
          :closable="false"
          show-icon
          title="迁移为控制面切换（隔离级别与连接串）；历史数据的物理搬迁由运维按部署手册执行。"
          style="margin-bottom: 16px"
        />
        <el-descriptions :column="1" border style="margin-bottom: 16px">
          <el-descriptions-item label="租户">{{ migrateTarget.name }}（{{ migrateTarget.code }}）</el-descriptions-item>
          <el-descriptions-item label="当前级别">
            <status-tag :value="migrateTarget.isolation" dict-code="tenant_isolation" />
          </el-descriptions-item>
        </el-descriptions>
        <el-form label-width="110px">
          <el-form-item label="目标级别">
            <el-radio-group v-model="migrateForm.isolation">
              <el-radio value="shared">共享库（shared）</el-radio>
              <el-radio value="dedicated">独立库（dedicated）</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="migrateForm.isolation === 'dedicated'" label="连接串" required>
            <el-input
              v-model="migrateForm.dbUrl"
              type="textarea"
              :rows="2"
              placeholder="postgresql://user:pass@host:5432/db（明文提交，服务端加密落库，绝不下发回显）"
            />
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button @click="migrateDialog = false">取消</el-button>
        <el-button type="primary" :loading="migrateSubmitting" @click="submitMigrate">派发迁移任务</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.fw-tenant-iso {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>

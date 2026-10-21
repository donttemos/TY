<!--
 * @file 审计日志页（运营视图）
 * @description PRD-005 FR-08 / PRD-015 FR-15-14~17：
 *   列表以「中文事件摘要 + 结果 + 风险 + 对象名称」为主列，技术字段默认收起；
 *   详情第一屏回答「谁 / 对什么 / 做了什么 / 为什么 / 结果如何」，技术详情折叠在末尾。
 *   事件名称、风险、字段中文名全部来自服务端注册表（`GET /audit-logs/events`），
 *   前端不维护第二份翻译表；旧行（无摘要/无事件码）走显式降级链并标注，不编造业务含义。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 移除 exportable：后端 /audit-logs/export 尚未实现
 * @modified 2026-10-15 donttemo N-02：恢复导出入口并改为异步任务；E-07：模块筛选项改字典
 * @modified 2026-10-20 donttemo M15 B3：列表运营视图 + 详情分层 + 结果/风险/租户筛选 + 旧数据降级
 * @modified 2026-10-20 donttemo M15 安全加固：操作人列改走 actorText（缺快照时显式标注），
 *   不再用当前用户列表的用户名回填历史行——改名会让历史记录显示错误的人
 * @modified 2026-10-21 donttemo P2：页面支持 `crossTenant` 双模式——同一份运营视图承载
 *   普通审计（单租户，`/audit-logs*`）与平台审计（跨租户，`/audit-logs/platform*`）。
 *   顶部常驻「查询范围」标识，平台模式增加租户列/租户筛选，并仅向 `system:tenant:ignore`
 *   持有者开放（普通入口不放宽：前端入口收敛 + 服务端独立校验双保险）
 * @modified 2026-10-21 donttemo P2 补齐历史审计追溯：新增「在线审计 / 归档审计」来源切换
 *   （普通模式 → `/audit-logs*` / `/audit-archives*`；平台模式 → `/audit-logs/platform*` /
 *   `/audit-archives/platform*`），范围提示同时标注「租户范围 + 数据来源」；归档表无独立详情端点，
 *   详情直接使用列表行（归档记录为不可变只读快照），导出产物与在线导出逐字节同构。
 *   租户筛选改为受控租户选项查询（`/audit-logs/platform/tenant-options`，远程搜索 + 行内批量
 *   名称解析），不再依赖 `tenant:read`，也不受「只取第一页 100 条」限制。
 * @module admin-web/views
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import CrudTable from '@/components/CrudTable/index.vue';
import DiffViewer from '@/components/DiffViewer/index.vue';
import TenantPicker from '@/components/TenantPicker/index.vue';
import * as auditApi from '@/api/audit';
import * as userApi from '@/api/user';
import { useAuditEvents } from '@/composables/useAuditEvents';
import { useAuditTenantDirectory } from '@/composables/useAuditTenantDirectory';
import { useJobCenterStore } from '@/composables/useJobCenter';
import { useUserStore } from '@/store/user';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { CrudColumn, SearchField, SearchModel } from '@/components/CrudTable/types';
import type { AuditEventDefinition, AuditLogRecord, AuditQuery, UserListItem } from '@/api/types';
import {
  CATEGORY_OPTIONS,
  RESULT_OPTIONS,
  RISK_OPTIONS,
  actorText,
  auditTitle,
  changeFieldMeta,
  isLegacyRow,
  resultMeta,
  riskMeta,
  sourceText,
  targetText,
} from './audit-display';

/** 数据来源：在线表（热数据）/ 归档表（冷数据）——两表同构、同权限码、同租户边界 */
type AuditSource = 'online' | 'archive';

/**
 * 查询模式（P2 平台审计）
 *
 * - `false`（默认）：普通审计页，数据源 `/audit-logs*` / `/audit-archives*`，服务端强制当前租户；
 * - `true`：平台审计页（`views/system/audit-logs/platform`），数据源 `/audit-logs/platform*` /
 *   `/audit-archives/platform*`，服务端 `@IgnoreTenant()` + `system:tenant:ignore` 开放租户维度
 *   （归属人范围照旧收敛）。
 *
 * 模式不是「前端开关放宽普通接口」：两条链路服务端权限边界不同，前端只负责入口收敛与展示口径。
 */
const props = withDefaults(defineProps<{ crossTenant?: boolean }>(), { crossTenant: false });

const user = useUserStore();
/** 普通审计权限：列表/详情需 audit:read（服务端同一权限码） */
const canRead = computed(() => user.hasPermission('audit:read'));
/** 跨租户维护权限：平台审计入口的另一把钥匙（服务端 @IgnoreTenant 守卫同码） */
const canCrossTenant = computed(() => user.hasPermission('system:tenant:ignore'));
/** 当前页面是否允许渲染数据区（平台模式两码同时要求；服务端仍独立校验） */
const allowed = computed(() => canRead.value && (!props.crossTenant || canCrossTenant.value));

/** 在线 / 归档切换（在线与冷数据是同一条历史链的两段，运营不需要开两个页面） */
const source = ref<AuditSource>('online');
const isArchive = computed(() => source.value === 'archive');
const sourceLabel = computed(() => (isArchive.value ? '归档审计' : '在线审计'));

/**
 * 列表数据源矩阵（模式 × 来源）
 *
 * 四种组合各自对应服务端一条独立链路；「归档不是越权后门」——普通模式归档端点同样强制当前租户，
 * 平台模式归档端点同样要求 `system:tenant:ignore`。
 */
const listEndpoint = computed(() => {
  if (props.crossTenant) return isArchive.value ? '/audit-archives/platform' : '/audit-logs/platform';
  return isArchive.value ? '/audit-archives' : '/audit-logs';
});

/**
 * 来源切换时强制重建 CrudTable
 *
 * 在线/归档的列、详情、导出都不同源；重建可把分页与查询区一起回到干净状态
 * （查询条件仍按「路由 + api」分别持久化，切回来不会丢用户输入）。租户筛选变化不重建，
 * 由 CrudTable 的 filters watcher 原地重查。
 */
const listKey = computed(() => listEndpoint.value);

/** 事件注册表（名称/风险/字段中文名的唯一来源） */
const auditEvents = useAuditEvents();

const baseColumns: CrudColumn[] = [
  { prop: 'summary', label: '事件', minWidth: 380, slot: 'event' },
  { prop: 'result', label: '结果', width: 96, align: 'center', slot: 'result' },
  { prop: 'risk', label: '风险', width: 92, align: 'center', slot: 'risk' },
  { prop: 'targetLabel', label: '对象', width: 160, slot: 'target' },
  { prop: 'userId', label: '操作人', width: 140, slot: 'user' },
  { prop: 'createdAt', label: '时间', width: 180, slot: 'createdAt', sortable: true },
  // 技术字段默认收起：需要排查时通过「列设置」打开
  { prop: 'module', label: '模块', width: 100, slot: 'module', defaultHidden: true },
  { prop: 'action', label: '动作', width: 100, slot: 'action', defaultHidden: true },
  { prop: 'ip', label: 'IP', width: 130, defaultHidden: true },
  { prop: 'traceId', label: 'traceId', minWidth: 160, defaultHidden: true },
];

/**
 * 列定义：跨租户模式在「对象」之后插入租户列（默认可见）——同一条事件发生在哪个租户
 * 是平台检索的第一判据，收起会让运营误读；普通模式记录恒属当前租户，不展示该列。
 */
const columns = computed<CrudColumn[]>(() => {
  if (!props.crossTenant) return baseColumns;
  const next = [...baseColumns];
  next.splice(4, 0, { prop: 'tenantId', label: '租户', width: 150, slot: 'tenant' });
  return next;
});

/** 查询区（>3 项自动折叠为「展开」） */
const searchForm = ref<SearchField[]>([
  { prop: 'user_id', label: '操作人', type: 'select', options: [] },
  { prop: 'category', label: '分类', type: 'select', options: CATEGORY_OPTIONS },
  { prop: 'result', label: '结果', type: 'select', options: RESULT_OPTIONS },
  { prop: 'risk', label: '风险', type: 'select', options: RISK_OPTIONS },
  // options 在 computed 中由注册表填充（事件码对运营不可读，label 用事件名）
  { prop: 'event', label: '事件', type: 'select', options: [] },
  { prop: 'from', label: '开始', type: 'date' },
  { prop: 'to', label: '结束', type: 'date' },
]);

/** 用户选项（筛选下拉） */
const userOptions = ref<{ label: string; value: string }[]>([]);

/**
 * 平台模式租户筛选（页面级，不进查询区）
 *
 * 走受控租户选项查询（远程搜索），而不是一次性拉管理面 `/tenants?pageSize=100`：
 * 后者要求 `tenant:read`（专职审计角色不该被迫持有），且租户数 >100 时下拉框与行内名称都会退化。
 */
const tenantFilter = ref('');
const tenantDirectory = useAuditTenantDirectory();

/** 固定过滤条件：租户筛选经 filters 注入（CrudTable 有变化即回到第一页重查） */
const crudFilters = computed<SearchModel>(() =>
  props.crossTenant && tenantFilter.value ? { tenant_id: tenantFilter.value } : {},
);

onMounted(async () => {
  void auditEvents.load();
  if (!allowed.value) return;
  try {
    const result = await userApi.fetchUsers({ pageSize: 100 });
    userOptions.value = result.items.map((user: UserListItem) => ({
      label: `${user.username}${user.nickname ? `（${user.nickname}）` : ''}`,
      value: user.id,
    }));
    const field = searchForm.value.find((f) => f.prop === 'user_id');
    if (field) field.options = userOptions.value;
  } catch {
    // 用户列表拉取失败：筛选退化为不可选，不阻塞列表
  }
});

/**
 * 列表加载完成后按行 tenantId 批量解析租户名称
 *
 * 只解析当前页出现且未缓存的 ID（受控端点 ids 模式，单批 ≤100），租户总量不影响查询成本；
 * 归档/在线两种来源共用同一目录。
 */
function handleLoaded(payload: { items: Record<string, unknown>[]; total: number }): void {
  if (!props.crossTenant || payload.items.length === 0) return;
  void tenantDirectory.resolveIds(payload.items.map((row) => (row as { tenantId?: string }).tenantId));
}

/** 事件下拉随注册表到达后填充（注册表失败时保持空，仍可按其他条件筛选） */
const eventOptions = computed(() => auditEvents.eventOptions.value);
const searchFields = computed<SearchField[]>(() =>
  searchForm.value.map((field) => (field.prop === 'event' ? { ...field, options: eventOptions.value } : field)),
);

/** 查询范围提示：租户范围 + 数据来源两个维度都必须一眼可辨 */
const scopeTitle = computed(
  () => `查询范围：${props.crossTenant ? '跨租户（平台维护入口）' : '单租户（当前租户）'} · 数据来源：${sourceLabel.value}`,
);
const scopeDescription = computed(() => {
  if (props.crossTenant) {
    return isArchive.value
      ? '检索归档表（已从在线表迁出的冷数据）：跨租户仅对持有 system:tenant:ignore 的平台维护账号开放，每次访问由服务端写 tenant_bypass 豁免审计；归档记录不可变，详情取自列表快照。'
      : '检索在线表：跨租户仅对持有 system:tenant:ignore 的平台维护账号开放，每次访问由服务端写 tenant_bypass 豁免审计；归属人范围仍按 dataScope 收敛。';
  }
  return isArchive.value
    ? '仅显示当前登录账号所属租户的归档审计（服务端强制，dataScope=all 也不跨租户）；归档记录不可变，详情取自列表快照。'
    : '仅显示当前登录账号所属租户的审计记录（服务端强制，dataScope=all 也不跨租户）；如需跨租户检索，请使用「平台审计」。';
});

/**
 * 查询条件变换：风险等级不落库，按注册表展开成事件码集合（ADR-0032 R9）
 *
 * 与「事件」同时选择时取交集；交集为空时用一个不存在的码，得到空结果而非全量——
 * 宁可显示 0 条，也不能把「高风险 + 某低风险事件」误解成「该事件全部」。
 * @param search 查询区原始值
 */
function toQuery(search: SearchModel): SearchModel {
  const next: SearchModel = { ...search };
  const risk = next.risk === undefined || next.risk === null ? '' : String(next.risk);
  const picked = next.event === undefined || next.event === null ? '' : String(next.event);
  delete next.risk;
  if (risk) {
    let codes = auditEvents.codesByRisk(risk);
    if (picked) codes = codes.filter((code) => code === picked);
    next.event = (codes.length > 0 ? codes : ['__none__']).join(',');
  }
  return next;
}

/**
 * 插槽行 → 审计记录
 *
 * CrudTable 的插槽把行标成 `Record<string, unknown>`（它不感知具体实体），
 * 这里集中做一次类型收窄，避免模板里散落 `as any`。
 * @param row 插槽行
 */
function asAudit(row: Record<string, unknown>): AuditLogRecord {
  return row as unknown as AuditLogRecord;
}

/** 当前行的事件定义（未登记返回 undefined，模板走降级链） */
function definitionOf(row: AuditLogRecord): AuditEventDefinition | undefined {
  return auditEvents.find(row.event);
}

function titleOf(row: AuditLogRecord): string {
  return auditTitle(row, definitionOf(row)).text;
}

function titleKindOf(row: AuditLogRecord): string {
  return auditTitle(row, definitionOf(row)).kind;
}

/** 详情抽屉 */
const detailVisible = ref(false);
const detail = ref<AuditLogRecord | null>(null);
const detailLoading = ref(false);
/** 当前详情是否来自归档表（归档行不可变，详情直接用列表快照，不请求详情端点） */
const detailFromArchive = ref(false);

const detailDefinition = computed<AuditEventDefinition | undefined>(() =>
  detail.value ? auditEvents.find(detail.value.event) : undefined,
);
const detailTitle = computed(() => (detail.value ? auditTitle(detail.value, detailDefinition.value) : null));
const detailResult = computed(() => resultMeta(detail.value?.result ?? null));
const detailRisk = computed(() => riskMeta(detailDefinition.value));
const detailFieldMeta = computed(() => changeFieldMeta(detailDefinition.value));
const detailLegacy = computed(() => (detail.value ? isLegacyRow(detail.value) : false));

async function openDetail(row: AuditLogRecord): Promise<void> {
  detailVisible.value = true;
  detailFromArchive.value = isArchive.value;
  // 归档表没有独立详情端点：列表 DTO 即完整只读快照（归档行不可变），直接用行数据渲染。
  // 在线表仍从详情端点取最新值（与列表同源授权，失败回退行内数据）。
  if (isArchive.value) {
    detail.value = row;
    detailLoading.value = false;
    return;
  }
  detail.value = row;
  detailLoading.value = true;
  try {
    // 模式决定详情端点：平台页走 platform 维护入口，普通页仍受服务端租户边界约束
    detail.value = props.crossTenant ? await auditApi.fetchPlatformAuditLog(row.id) : await auditApi.fetchAuditLog(row.id);
  } catch (err) {
    // 详情拉取失败时回退行内数据
    detail.value = row;
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '详情加载失败');
  } finally {
    detailLoading.value = false;
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

// 操作人列只认写入时固化的名称快照（见模板 #cell-user）：不回退 `userOptions`（当前用户列表）——
// 管理员改名后历史行必须仍显示事件发生时的名称，没有快照就如实标注「名称快照缺失」。
function copyTraceId(traceId: string): void {
  void navigator.clipboard.writeText(traceId).then(() => ElMessage.success('traceId 已复制'));
}

/** 原始快照（技术详情展示；敏感字段已由服务端脱敏） */
function pretty(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 任务中心（导出进度 / 下载入口在全局任务条上） */
const jobCenter = useJobCenterStore();
const exporting = ref(false);

/**
 * 导出当前筛选条件下的审计日志（N-02 异步任务）
 *
 * payload.search 已由 CrudTable 用同一份 `toQuery` 变换过（风险 → 事件集合），
 * 这里不得再次变换，否则风险筛选会被展开两次。
 * 端点按「模式 × 来源」四选一：在线/归档导出产物逐字节同构，但数据源与权限入口不同。
 */
async function handleExport(payload: { search: SearchModel; sort: string | null }): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const query: AuditQuery = { ...(payload.search as AuditQuery) };
    if (payload.sort) query.sort = payload.sort;
    const job = isArchive.value
      ? props.crossTenant
        ? await auditApi.exportPlatformArchiveAuditLogs(query)
        : await auditApi.exportArchiveAuditLogs(query)
      : props.crossTenant
        ? await auditApi.exportPlatformAuditLogs(query)
        : await auditApi.exportAuditLogs(query);
    jobCenter.track(job);
    ElMessage.success('导出任务已派发，可在底部任务条查看进度');
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '导出任务派发失败，请稍后重试');
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div class="fw-page">
    <!-- 在线 / 归档来源切换 + 平台模式租户筛选（受控远程搜索） -->
    <div class="fw-audit-toolbar">
      <el-radio-group v-model="source" size="small" class="fw-audit-source">
        <el-radio-button value="online">在线审计</el-radio-button>
        <el-radio-button value="archive">归档审计</el-radio-button>
      </el-radio-group>
      <TenantPicker
        v-if="crossTenant && allowed"
        v-model="tenantFilter"
        :fetcher="tenantDirectory.search"
        placeholder="按租户筛选（可搜索）"
        width="240px"
      />
      <span v-if="crossTenant" class="fw-audit-hint">租户选项走审计受控查询，无需 tenant:read</span>
    </div>

    <!-- 查询范围常驻标识（P2）：租户范围 + 数据来源必须一眼可辨，避免运营把两类结果混读 -->
    <el-alert
      class="fw-audit-scope"
      :type="crossTenant ? 'warning' : 'info'"
      :closable="false"
      show-icon
      :title="scopeTitle"
      :description="scopeDescription"
    />

    <!-- 入口收敛：平台模式缺 system:tenant:ignore 时不渲染数据区（服务端同样会拒绝，非唯一防线） -->
    <el-result
      v-if="!allowed"
      icon="warning"
      title="无权访问平台审计"
      sub-title="平台审计仅向持有 system:tenant:ignore（跨租户维护）且持 audit:read 的账号开放。普通审计页不受影响。"
    />

    <template v-else>
      <CrudTable
        :key="listKey"
        :api="listEndpoint"
        :filters="crudFilters"
        :columns="columns"
        :search-form="searchFields"
        :transform-search="toQuery"
        permission="audit"
        exportable
        @export="handleExport"
        @loaded="handleLoaded"
      >
        <!-- 事件摘要：业务摘要优先，旧行显式标注来源（不编造） -->
        <template #cell-event="{ row }">
          <div class="fw-audit-event">
            <span class="fw-audit-event-text">{{ titleOf(asAudit(row)) }}</span>
            <el-tag v-if="titleKindOf(asAudit(row)) === 'legacy'" size="small" type="info" effect="plain">历史记录</el-tag>
            <el-tag v-else-if="titleKindOf(asAudit(row)) === 'unregistered'" size="small" type="warning" effect="plain">未登记事件</el-tag>
          </div>
        </template>
        <template #cell-result="{ row }">
          <el-tag size="small" :type="resultMeta(asAudit(row).result).tagType" effect="light">{{ resultMeta(asAudit(row).result).label }}</el-tag>
        </template>
        <template #cell-risk="{ row }">
          <el-tag v-if="riskMeta(definitionOf(asAudit(row)))" size="small" :type="riskMeta(definitionOf(asAudit(row)))!.tagType" effect="plain">
            {{ riskMeta(definitionOf(asAudit(row)))!.label }}
          </el-tag>
          <span v-else class="fw-text-weak">—</span>
        </template>
        <template #cell-target="{ row }">{{ targetText(asAudit(row)) }}</template>
        <!-- 租户列（仅跨租户模式）：'0' 按契约标注「未知/存量」，不冒充某个租户 -->
        <template #cell-tenant="{ row }">{{ tenantDirectory.nameOf(asAudit(row).tenantId) }}</template>
        <!-- 操作人只认写入时固化的名称快照；缺快照时标注「名称快照缺失（ID: …）」，不用当前用户名回填 -->
        <template #cell-user="{ row }">{{ actorText(asAudit(row)) }}</template>
        <template #cell-createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
        <template #cell-module="{ row }">{{ row.module }}</template>
        <template #cell-action="{ row }">{{ row.action }}</template>
        <template #actions-extra="{ row }">
          <el-button link type="primary" @click="openDetail(asAudit(row))">详情</el-button>
        </template>
      </CrudTable>
    </template>

    <!-- 审计详情：业务区在前，技术详情折叠 -->
    <el-drawer v-model="detailVisible" title="审计详情" size="640px">
      <div v-loading="detailLoading">
        <template v-if="detail">
          <div class="fw-audit-headline">
            <h3 class="fw-audit-headline-title">{{ detailTitle?.text }}</h3>
            <div class="fw-audit-tags">
              <el-tag :type="detailResult.tagType" effect="light">{{ detailResult.label }}</el-tag>
              <el-tag v-if="detailRisk" :type="detailRisk.tagType" effect="plain">风险：{{ detailRisk.label }}</el-tag>
              <el-tag v-if="detailDefinition?.reviewRequired" type="danger" effect="plain">需复核</el-tag>
              <el-tag v-if="detailFromArchive" type="info" effect="plain">归档记录（只读快照）</el-tag>
              <el-tag v-if="detailTitle?.kind === 'legacy'" type="info" effect="plain">历史记录（无业务摘要）</el-tag>
              <el-tag v-else-if="detailTitle?.kind === 'unregistered'" type="warning" effect="plain">未登记事件</el-tag>
            </div>
          </div>

          <el-alert
            v-if="detailFromArchive"
            class="fw-audit-legacy"
            type="info"
            :closable="false"
            show-icon
            title="该记录来自归档表（冷数据）"
            description="归档记录是迁移时的只读快照，不再变化；详情直接取自列表数据，不走在线详情端点。"
          />

          <el-alert
            v-if="detailLegacy"
            class="fw-audit-legacy"
            type="info"
            :closable="false"
            show-icon
            title="该记录产生于业务摘要上线前，仅保留技术字段"
            description="系统不会为历史记录补写摘要或原因，以免伪造当时不存在的事实。"
          />

          <el-descriptions :column="2" border>
            <el-descriptions-item label="事件">{{ detailDefinition?.name ?? detail.event ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="操作人">{{ actorText(detail) }}</el-descriptions-item>
            <el-descriptions-item label="操作对象">{{ targetText(detail) }}</el-descriptions-item>
            <!-- 跨租户模式下「哪个租户」是业务第一判据；单租户模式逐行重复同一值没有信息量 -->
            <el-descriptions-item v-if="crossTenant" label="所属租户">{{ tenantDirectory.nameOf(detail.tenantId) }}</el-descriptions-item>
            <el-descriptions-item label="记录来源">{{ sourceText(detail) }}</el-descriptions-item>
            <el-descriptions-item label="操作原因" :span="2">{{ detail.reason ?? '未填写' }}</el-descriptions-item>
            <el-descriptions-item v-if="detailDefinition?.description" label="事件说明" :span="2">
              {{ detailDefinition.description }}
            </el-descriptions-item>
            <el-descriptions-item v-if="detailDefinition?.guidance" label="处理指引" :span="2">
              {{ detailDefinition.guidance }}
            </el-descriptions-item>
          </el-descriptions>

          <h4 class="fw-audit-diff-title">变更前后值（敏感字段已脱敏）</h4>
          <diff-viewer :before="detail.beforeValue" :after="detail.afterValue" :field-meta="detailFieldMeta" />

          <el-collapse class="fw-audit-tech">
            <el-collapse-item title="技术详情（事件码 / 链路 / 原始快照）" name="tech">
              <el-descriptions :column="1" border size="small">
                <el-descriptions-item label="事件码">{{ detail.event ?? '—' }}</el-descriptions-item>
                <el-descriptions-item label="模块 / 动作">{{ detail.module }} / {{ detail.action }}</el-descriptions-item>
                <el-descriptions-item label="分类">{{ detail.category ?? '—' }}</el-descriptions-item>
                <el-descriptions-item label="结果值">{{ detail.result ?? '—' }}</el-descriptions-item>
                <el-descriptions-item label="租户">{{ detail.tenantId }}（0 = 未知/存量）</el-descriptions-item>
                <el-descriptions-item label="请求 ID">{{ detail.requestId ?? '—' }}</el-descriptions-item>
                <el-descriptions-item label="链路 ID">
                  <span v-if="detail.traceId" class="fw-audit-trace" @click="copyTraceId(detail.traceId)">{{ detail.traceId }}</span>
                  <span v-else>—</span>
                </el-descriptions-item>
                <el-descriptions-item label="令牌族">{{ detail.familyId ?? '—' }}</el-descriptions-item>
                <el-descriptions-item label="jti">{{ detail.jti ?? '—' }}</el-descriptions-item>
                <el-descriptions-item label="IP">{{ detail.ip ?? '—' }}</el-descriptions-item>
                <el-descriptions-item label="User-Agent">{{ detail.userAgent ?? '—' }}</el-descriptions-item>
                <el-descriptions-item label="记录时间">{{ formatTime(detail.createdAt) }}</el-descriptions-item>
              </el-descriptions>
              <h5 class="fw-audit-raw-title">原始 before / after</h5>
              <pre class="fw-audit-raw">{{ pretty(detail.beforeValue) }}</pre>
              <pre class="fw-audit-raw">{{ pretty(detail.afterValue) }}</pre>
            </el-collapse-item>
          </el-collapse>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.fw-audit-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.fw-audit-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.fw-audit-scope {
  margin-bottom: 12px;
}

.fw-audit-event {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fw-audit-event-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fw-audit-headline {
  margin-bottom: 12px;
}

.fw-audit-headline-title {
  margin: 0 0 8px;
  font-size: 16px;
  line-height: 1.5;
}

.fw-audit-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.fw-audit-legacy {
  margin-bottom: 12px;
}

.fw-audit-trace {
  color: var(--el-color-primary);
  cursor: pointer;
  font-family: monospace;
}

.fw-audit-diff-title {
  margin: 16px 0 8px;
  font-size: 14px;
}

.fw-audit-tech {
  margin-top: 16px;
}

.fw-audit-raw-title {
  margin: 12px 0 6px;
  font-size: 13px;
}

.fw-audit-raw {
  max-height: 200px;
  overflow: auto;
  margin: 0 0 8px;
  padding: 8px 12px;
  background: var(--fw-bg);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
}
</style>

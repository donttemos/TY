<!--
 * @file 审计日志页（运营视图；admin 模板）
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
 * @modified 2026-10-20 donttemo 模板裁剪：模板服务端未注册 /audit-logs/export（任务中心不在模板范围），
 *   故不带导出入口；模板无租户管理模块，查询区不含租户筛选。需要时参照 apps/admin-web 同名文件补回。
 * @module __APP_NAME__-web/views
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import CrudTable from '@/components/CrudTable/index.vue';
import DiffViewer from '@/components/DiffViewer/index.vue';
import * as auditApi from '@/api/audit';
import * as userApi from '@/api/user';
import { useAuditEvents } from '@/composables/useAuditEvents';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { CrudColumn, SearchField, SearchModel } from '@/components/CrudTable/types';
import type { AuditEventDefinition, AuditLogRecord, UserListItem } from '@/api/types';
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

/** 事件注册表（名称/风险/字段中文名的唯一来源） */
const auditEvents = useAuditEvents();

const columns: CrudColumn[] = [
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

/** 用户 / 租户选项（筛选下拉） */
const userOptions = ref<{ label: string; value: string }[]>([]);

onMounted(async () => {
  void auditEvents.load();
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

/** 事件下拉随注册表到达后填充（注册表失败时保持空，仍可按其他条件筛选） */
const eventOptions = computed(() => auditEvents.eventOptions.value);
const searchFields = computed<SearchField[]>(() =>
  searchForm.value.map((field) => (field.prop === 'event' ? { ...field, options: eventOptions.value } : field)),
);

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
  detailLoading.value = true;
  try {
    detail.value = await auditApi.fetchAuditLog(row.id);
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

</script>

<template>
  <div class="fw-page">
    <CrudTable
      api="/audit-logs"
      :columns="columns"
      :search-form="searchFields"
      :transform-search="toQuery"
      permission="audit"
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
      <!-- 操作人只认写入时固化的名称快照；缺快照时标注「名称快照缺失（ID: …）」，不用当前用户名回填 -->
      <template #cell-user="{ row }">{{ actorText(asAudit(row)) }}</template>
      <template #cell-createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
      <template #cell-module="{ row }">{{ row.module }}</template>
      <template #cell-action="{ row }">{{ row.action }}</template>
      <template #actions-extra="{ row }">
        <el-button link type="primary" @click="openDetail(asAudit(row))">详情</el-button>
      </template>
    </CrudTable>

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
              <el-tag v-if="detailTitle?.kind === 'legacy'" type="info" effect="plain">历史记录（无业务摘要）</el-tag>
              <el-tag v-else-if="detailTitle?.kind === 'unregistered'" type="warning" effect="plain">未登记事件</el-tag>
            </div>
          </div>

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

<!--
 * @file 审计日志页
 * @description PRD-005 FR-08 / TC-WEB-004：按人 / 模块 / 动作 / 时间区间查询；
 *   详情抽屉展示字段级 diff（before → after，敏感字段脱敏，见 DiffViewer）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 移除 exportable：后端 /audit-logs/export 尚未实现
 *   （docs/40-api-spec.md §3.7 标注 Backlog），按钮点了无任何反应属死 UI
 * @modified 2026-10-15 donttemo N-02：恢复导出入口并改为**异步任务**——点击只派发任务拿到 jobId，
 *   进度与下载由全局任务条（layout/JobBar.vue）承载，页面不阻塞；失败可在任务条上重试并看到 traceId
 * @modified 2026-10-15 donttemo E-07：模块筛选项由硬编码改为 audit_module 字典消费（原选项过期：
 *   缺 tenant 且含从未写入审计的 order）
 * @module admin-web/views
-->

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import CrudTable from '@/components/CrudTable/index.vue';
import DiffViewer from '@/components/DiffViewer/index.vue';
import * as auditApi from '@/api/audit';
import * as userApi from '@/api/user';
import { useJobCenterStore } from '@/composables/useJobCenter';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { CrudColumn, SearchField, SearchModel } from '@/components/CrudTable/types';
import type { AuditLogRecord, AuditQuery, UserListItem } from '@/api/types';

const columns: CrudColumn[] = [
  { prop: 'userId', label: '操作人', width: 120, slot: 'user' },
  { prop: 'module', label: '模块', width: 100, align: 'center', sortable: true },
  { prop: 'action', label: '动作', width: 100, align: 'center', slot: 'action', sortable: true },
  { prop: 'targetType', label: '对象', width: 140, slot: 'target', sortable: true },
  { prop: 'ip', label: 'IP', width: 130 },
  { prop: 'traceId', label: 'traceId', minWidth: 160 },
  { prop: 'createdAt', label: '时间', width: 180, slot: 'createdAt', sortable: true },
];

const searchForm: SearchField[] = [
  { prop: 'user_id', label: '操作人', type: 'select', options: [] },
  // E-07：模块取值走 audit_module 字典（原硬编码选项过期——缺 tenant 且含从未写入审计的 order）
  { prop: 'module', label: '模块', type: 'select', dictCode: 'audit_module' },
  { prop: 'action', label: '动作', type: 'select', dictCode: 'audit_action' },
  { prop: 'from', label: '开始', type: 'date' },
  { prop: 'to', label: '结束', type: 'date' },
];

/** 用户选项（操作人筛选） */
const userOptions = ref<{ label: string; value: string }[]>([]);

onMounted(async () => {
  try {
    const result = await userApi.fetchUsers({ pageSize: 100 });
    userOptions.value = result.items.map((user: UserListItem) => ({ label: `${user.username}${user.nickname ? `（${user.nickname}）` : ''}`, value: user.id }));
    const field = searchForm.find((f) => f.prop === 'user_id');
    if (field) field.options = userOptions.value;
  } catch {
    // 用户列表拉取失败时退化为手动输入 user_id 的场景不存在，仅留空选项
  }
});

/** 详情抽屉 */
const detailVisible = ref(false);
const detail = ref<AuditLogRecord | null>(null);
const detailLoading = ref(false);

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

function userName(userId: string | null): string {
  if (!userId) return '系统';
  return userOptions.value.find((u) => u.value === userId)?.label ?? userId;
}

function copyTraceId(traceId: string): void {
  void navigator.clipboard.writeText(traceId).then(() => ElMessage.success('traceId 已复制'));
}

/** 任务中心（导出进度 / 下载入口在全局任务条上） */
const jobCenter = useJobCenterStore();
const exporting = ref(false);

/**
 * 导出当前筛选条件下的审计日志（N-02 异步任务）
 *
 * 只派发、不等结果：后端立即返回 jobId，进度与产物由任务条接管。
 * 这样即使筛选结果上万条，页面也不会被卡住，用户可以直接跳去别的页面。
 */
async function handleExport(payload: { search: SearchModel; sort: string | null }): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const query: AuditQuery = { ...(payload.search as AuditQuery) };
    if (payload.sort) query.sort = payload.sort;
    const job = await auditApi.exportAuditLogs(query);
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
    <!-- permission="audit" → 导出按钮自动按 audit:export 判权（与后端 PERM.AUDIT_EXPORT 同码） -->
    <CrudTable
      api="/audit-logs"
      :columns="columns"
      :search-form="searchForm"
      permission="audit"
      exportable
      @export="handleExport"
    >
      <template #cell-user="{ row }">
        {{ userName(row.userId) }}
      </template>
      <template #cell-action="{ row }">
        <el-tag size="small" :type="row.action === 'delete' ? 'danger' : row.action === 'create' ? 'success' : 'warning'" effect="light">
          {{ row.action }}
        </el-tag>
      </template>
      <template #cell-target="{ row }">
        <span v-if="row.targetType">{{ row.targetType }}:{{ row.targetId }}</span>
        <span v-else class="fw-text-weak">—</span>
      </template>
      <template #cell-createdAt="{ row }">
        {{ formatTime(row.createdAt) }}
      </template>
      <template #actions-extra="{ row }">
        <el-button link type="primary" @click="openDetail(row)">详情</el-button>
      </template>
    </CrudTable>

    <!-- 审计详情：字段级 diff -->
    <el-drawer v-model="detailVisible" title="审计详情" size="560px">
      <div v-loading="detailLoading">
        <template v-if="detail">
          <el-descriptions :column="2" border>
            <el-descriptions-item label="操作人">{{ userName(detail.userId) }}</el-descriptions-item>
            <el-descriptions-item label="模块 / 动作">{{ detail.module }} / {{ detail.action }}</el-descriptions-item>
            <el-descriptions-item label="对象">{{ detail.targetType ? `${detail.targetType}:${detail.targetId}` : '—' }}</el-descriptions-item>
            <el-descriptions-item label="IP">{{ detail.ip ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="时间">{{ formatTime(detail.createdAt) }}</el-descriptions-item>
            <el-descriptions-item label="traceId">
              <span v-if="detail.traceId" class="fw-audit-trace" @click="copyTraceId(detail.traceId)">{{ detail.traceId }}</span>
              <span v-else>—</span>
            </el-descriptions-item>
            <el-descriptions-item label="User-Agent" :span="2">{{ detail.userAgent ?? '—' }}</el-descriptions-item>
          </el-descriptions>
          <h4 class="fw-audit-diff-title">变更前后值（敏感字段已脱敏）</h4>
          <diff-viewer :before="detail.beforeValue" :after="detail.afterValue" />
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.fw-audit-trace {
  color: var(--el-color-primary);
  cursor: pointer;
  font-family: monospace;
}

.fw-audit-diff-title {
  margin: 16px 0 8px;
  font-size: 14px;
}
</style>

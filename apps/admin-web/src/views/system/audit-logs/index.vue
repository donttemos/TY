<!--
 * @file 审计日志页
 * @description PRD-005 FR-08 / TC-WEB-004：按人 / 模块 / 动作 / 时间区间查询；
 *   详情抽屉展示字段级 diff（before → after，敏感字段脱敏，见 DiffViewer）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 移除 exportable：后端 /audit-logs/export 尚未实现
 *   （docs/40-api-spec.md §3.7 标注 Backlog），按钮点了无任何反应属死 UI
 * @module admin-web/views
-->

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import CrudTable from '@/components/CrudTable/index.vue';
import DiffViewer from '@/components/DiffViewer/index.vue';
import * as auditApi from '@/api/audit';
import * as userApi from '@/api/user';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { CrudColumn, SearchField } from '@/components/CrudTable/types';
import type { AuditLogRecord, UserListItem } from '@/api/types';

const columns: CrudColumn[] = [
  { prop: 'userId', label: '操作人', width: 120, slot: 'user' },
  { prop: 'module', label: '模块', width: 100, align: 'center' },
  { prop: 'action', label: '动作', width: 100, align: 'center', slot: 'action' },
  { prop: 'targetType', label: '对象', width: 140, slot: 'target' },
  { prop: 'ip', label: 'IP', width: 130 },
  { prop: 'traceId', label: 'traceId', minWidth: 160 },
  { prop: 'createdAt', label: '时间', width: 180, slot: 'createdAt' },
];

const searchForm: SearchField[] = [
  { prop: 'user_id', label: '操作人', type: 'select', options: [] },
  { prop: 'module', label: '模块', type: 'select', options: [
    { label: '用户', value: 'user' },
    { label: '角色', value: 'role' },
    { label: '认证', value: 'auth' },
    { label: '订单', value: 'order' },
  ] },
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
</script>

<template>
  <div class="fw-page">
    <CrudTable api="/audit-logs" :columns="columns" :search-form="searchForm" permission="audit">
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

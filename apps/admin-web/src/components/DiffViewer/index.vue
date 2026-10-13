<!--
 * @file 审计 diff 查看器
 * @description 审计详情字段级 diff（原型 §5.5）：before_value → after_value 逐字段对照，
 *   敏感字段（password / token / secret 等）显示 ***；JSON 值格式化展示。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/components
-->

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  before: unknown;
  after: unknown;
}>();

/** 敏感字段名（命中即打码；与后端脱敏规则同名，双保险） */
const SENSITIVE_KEYS = ['password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'secret', 'idCard', 'phone', 'email'];

/** 敏感值打码 */
function maskValue(value: unknown): string {
  if (value === null || value === undefined) return '***';
  return '***';
}

interface DiffRow {
  key: string;
  before: string;
  after: string;
  changed: boolean;
}

const rows = computed<DiffRow[]>(() => {
  const before = isRecord(props.before) ? props.before : null;
  const after = isRecord(props.after) ? props.after : null;
  if (!before && !after) {
    // 非对象值（如 login 动作无前后值）
    return [
      { key: '—', before: format(props.before), after: format(props.after), changed: format(props.before) !== format(props.after) },
    ];
  }
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  return keys.map((key) => {
    const isSensitive = SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s.toLowerCase()));
    const beforeText = isSensitive ? maskValue(before?.[key]) : format(before?.[key]);
    const afterText = isSensitive ? maskValue(after?.[key]) : format(after?.[key]);
    return { key, before: beforeText, after: afterText, changed: beforeText !== afterText };
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function format(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
</script>

<template>
  <div class="fw-diff">
    <el-table :data="rows" size="small" border>
      <el-table-column prop="key" label="字段" width="160" />
      <el-table-column prop="before" label="变更前" />
      <el-table-column prop="after" label="变更后" />
      <el-table-column label="变化" width="80" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.changed" type="warning" size="small">变更</el-tag>
          <span v-else class="fw-text-weak">—</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

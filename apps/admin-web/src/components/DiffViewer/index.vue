<!--
 * @file 审计 diff 查看器
 * @description 审计详情字段级 diff（原型 §5.5）：before_value → after_value 逐字段对照，
 *   敏感字段（password / token / secret 等）显示 ***；JSON 值格式化展示。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-20 donttemo M15（PRD-015 FR-15-15）：新增 `fieldMeta` —— 字段中文名与枚举值文案
 *   由事件注册表提供（如 `status: 3 → 冻结`），组件只负责渲染，不在前端硬编码事件字典。
 * @module admin-web/components
-->

<script setup lang="ts">
import { computed } from 'vue';

/** 字段展示元数据（来自事件注册表 changeFields） */
export interface DiffFieldMeta {
  label: string;
  /** 枚举取值 → 业务文案（如 `3` → `冻结`） */
  valueLabels?: Record<string, string>;
}

const props = defineProps<{
  before: unknown;
  after: unknown;
  /** 字段中文名与枚举翻译；缺省时显示原始字段名与原始值 */
  fieldMeta?: Record<string, DiffFieldMeta>;
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
  /** 展示名（中文名优先，缺省回退字段名） */
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

/**
 * 取值格式化：枚举按注册表翻译，其余走 JSON/字符串
 * @param value 原始值
 * @param meta 字段元数据
 */
function formatValue(value: unknown, meta?: DiffFieldMeta): string {
  const text = format(value);
  if (!meta?.valueLabels) return text;
  return meta.valueLabels[text] ?? text;
}

const rows = computed<DiffRow[]>(() => {
  const before = isRecord(props.before) ? props.before : null;
  const after = isRecord(props.after) ? props.after : null;
  if (!before && !after) {
    // 非对象值（如 login 动作无前后值）
    const beforeText = format(props.before);
    const afterText = format(props.after);
    return [{ key: '—', label: '—', before: beforeText, after: afterText, changed: beforeText !== afterText }];
  }
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  return keys.map((key) => {
    const meta = props.fieldMeta?.[key];
    const isSensitive = SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s.toLowerCase()));
    const beforeText = isSensitive ? maskValue(before?.[key]) : formatValue(before?.[key], meta);
    const afterText = isSensitive ? maskValue(after?.[key]) : formatValue(after?.[key], meta);
    return { key, label: meta?.label ?? key, before: beforeText, after: afterText, changed: beforeText !== afterText };
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
      <el-table-column prop="label" label="字段" width="160" />
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

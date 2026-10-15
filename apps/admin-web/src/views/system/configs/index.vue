<!--
 * @file 参数配置页（M9 / PRD-009 FR-07）
 * @description 配置中心管理页：白名单键值列表（只读列 + 来源标记 env/runtime + 最近变更时间）、
 *   在线修改弹窗（log.level 走枚举下拉，数字键走数值输入——服务端复用 env 同一份校验器，
 *   非法值 400/5002 带原因回显且旧值保持）、变更历史抽屉（审计 module=config 过滤，
 *   展示 old → new / 来源 / 操作者 / 时间；入口需 audit:read，无权限不渲染）。
 *   boot 键（端口 / 驱动 / 连接串 / 密钥）env 独占不进列表——改动属进程形态变更，必须走重启（5001 语义覆盖）。
 *   权限：system:config:read（页面本体）/ system:config:write（修改按钮）；无 read 时菜单不出现。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/views
-->

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import * as configApi from '@/api/config';
import { request } from '@/utils/request';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { AuditLogRecord, ConfigCenterMetaInfo, ConfigEntry } from '@/api/types';

/** ---------- 列表 ---------- */
const loading = ref(false);
const entries = ref<ConfigEntry[]>([]);
const meta = ref<ConfigCenterMetaInfo | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await configApi.fetchConfigs();
    entries.value = result.configs;
    meta.value = result.meta;
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '加载参数配置失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** ---------- 编辑 ---------- */
const editVisible = ref(false);
const editSubmitting = ref(false);
const editTarget = ref<ConfigEntry | null>(null);
/** log.level 是唯一字符串键：走枚举下拉；其余全部数字键（两个 ref 分型，避免模板内类型体操） */
const editStringValue = ref('');
const editNumberValue = ref(0);

const LOG_LEVEL_OPTIONS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/** 是否字符串键（当前即 log.level） */
function isStringKey(entry: ConfigEntry): boolean {
  return typeof entry.value === 'string';
}

/** 小数键（步进 0.1），其余整数键步进 1 */
function stepOf(entry: ConfigEntry): number {
  return entry.key === 'cache.ttlJitter' || entry.key === 'otel.sampleRatio' ? 0.1 : 1;
}

function openEdit(entry: ConfigEntry): void {
  editTarget.value = entry;
  if (isStringKey(entry)) editStringValue.value = String(entry.value);
  else editNumberValue.value = entry.value as number;
  editVisible.value = true;
}

async function submitEdit(): Promise<void> {
  const target = editTarget.value;
  if (!target) return;
  const value = isStringKey(target) ? editStringValue.value : editNumberValue.value;
  if (isStringKey(target) && !LOG_LEVEL_OPTIONS.includes(editStringValue.value as (typeof LOG_LEVEL_OPTIONS)[number])) {
    ElMessage.warning('日志级别取值非法');
    return;
  }
  if (!isStringKey(target) && !Number.isFinite(editNumberValue.value)) {
    ElMessage.warning('请输入数字');
    return;
  }
  editSubmitting.value = true;
  try {
    await configApi.updateConfig(target.key, value);
    ElMessage.success(`参数 ${target.key} 已生效`);
    editVisible.value = false;
    await load();
  } catch (err) {
    // 5002 带字段级原因（describeBizError 拼 details）、5001/5003/3002 各有专属文案
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '修改失败，请重试');
  } finally {
    editSubmitting.value = false;
  }
}

/** ---------- 变更历史（审计 module=config） ---------- */
const historyVisible = ref(false);
const historyLoading = ref(false);
const historyLogs = ref<AuditLogRecord[]>([]);

async function openHistory(): Promise<void> {
  historyVisible.value = true;
  historyLoading.value = true;
  try {
    const result = await request.get<{ items: AuditLogRecord[]; total: number }>('/audit-logs', {
      params: { module: 'config', page: 1, pageSize: 50, sort: 'created_at:desc' },
    });
    historyLogs.value = result.items;
  } catch (err) {
    ElMessage.error(err instanceof BizError ? describeBizError(err) : '变更历史加载失败');
  } finally {
    historyLoading.value = false;
  }
}

/** 审计 before/after 解构（{ value, source?, operator?, ok?, reason? }） */
interface ConfigAuditPayload {
  value?: unknown;
  source?: string;
  operator?: string;
  ok?: boolean;
  reason?: string;
}

function auditBefore(log: AuditLogRecord): ConfigAuditPayload {
  return (log.beforeValue ?? {}) as ConfigAuditPayload;
}

function auditAfter(log: AuditLogRecord): ConfigAuditPayload {
  return (log.afterValue ?? {}) as ConfigAuditPayload;
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
</script>

<template>
  <div class="fw-page">
    <el-card shadow="never" class="fw-config-meta">
      <div class="fw-config-meta-row">
        <span class="fw-config-meta-item">事实源：{{ meta?.driver ?? '—' }}</span>
        <span class="fw-config-meta-item">快照版本：{{ meta?.snapshotVersion ?? '—' }}</span>
        <span class="fw-config-meta-item">轮询间隔：{{ meta?.pollSeconds != null ? `${meta.pollSeconds}s` : '—' }}</span>
        <span class="fw-config-meta-item">最近生效：{{ formatTime(meta?.lastAppliedAt ?? null) }}</span>
        <span style="flex: 1"></span>
        <el-button v-permission="'audit:read'" link type="primary" @click="openHistory">变更历史</el-button>
        <el-button link @click="load">刷新</el-button>
      </div>
      <el-alert
        v-if="meta?.lastError"
        type="warning"
        :title="`最近一次错误：${meta.lastError}`"
        :closable="false"
        show-icon
        style="margin-top: 8px"
      />
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="仅白名单内的运行时参数支持不重启生效；端口 / 驱动 / 连接串 / 密钥等 boot 键改动需修改环境变量并重启进程。"
        style="margin-top: 8px"
      />
    </el-card>

    <el-table v-loading="loading" :data="entries" border stripe style="margin-top: 12px">
      <el-table-column prop="key" label="参数键" min-width="180" />
      <el-table-column label="当前值" min-width="140">
        <template #default="{ row }">
          <code class="fw-config-value">{{ formatValue((row as ConfigEntry).value) }}</code>
        </template>
      </el-table-column>
      <el-table-column label="来源" width="110" align="center">
        <template #default="{ row }">
          <el-tag :type="(row as ConfigEntry).source === 'runtime' ? 'warning' : 'info'" size="small">
            {{ (row as ConfigEntry).source === 'runtime' ? '运行时覆盖' : 'env 默认' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="envKey" label="环境变量" min-width="170">
        <template #default="{ row }">
          <code class="fw-config-value">{{ (row as ConfigEntry).envKey }}</code>
        </template>
      </el-table-column>
      <el-table-column label="最近变更" width="170">
        <template #default="{ row }">
          {{ formatTime((row as ConfigEntry).updatedAt) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" align="center" fixed="right">
        <template #default="{ row }">
          <el-button v-permission="'system:config:write'" link type="primary" @click="openEdit(row as ConfigEntry)">修改</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 修改弹窗：服务端 5002 会带字段级原因（旧值保持），提示直接展示拒绝原因 -->
    <el-dialog v-model="editVisible" title="修改参数" width="480px">
      <template v-if="editTarget">
        <el-descriptions :column="1" border style="margin-bottom: 16px">
          <el-descriptions-item label="参数键">{{ editTarget.key }}</el-descriptions-item>
          <el-descriptions-item label="当前值">
            <code class="fw-config-value">{{ formatValue(editTarget.value) }}</code>
          </el-descriptions-item>
        </el-descriptions>
        <el-form label-width="80px" @submit.prevent>
          <el-form-item label="新值" required>
            <el-select v-if="isStringKey(editTarget)" v-model="editStringValue" style="width: 100%">
              <el-option v-for="option in LOG_LEVEL_OPTIONS" :key="option" :label="option" :value="option" />
            </el-select>
            <el-input-number v-else v-model="editNumberValue" style="width: 100%" :step="stepOf(editTarget)" />
          </el-form-item>
        </el-form>
        <el-alert type="warning" :closable="false" show-icon title="修改立即生效并写入审计；非法值会被服务端拒绝且当前值保持不变。" />
      </template>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editSubmitting" @click="submitEdit">保存并生效</el-button>
      </template>
    </el-dialog>

    <!-- 变更历史抽屉：审计 module=config（成功与失败变更都可追溯） -->
    <el-drawer v-model="historyVisible" title="配置变更历史（最近 50 条）" size="720px">
      <el-table v-loading="historyLoading" :data="historyLogs" border size="small">
        <el-table-column label="时间" width="155">
          <template #default="{ row }">{{ formatTime((row as AuditLogRecord).createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="targetId" label="参数键" min-width="120" />
        <el-table-column label="旧 → 新" min-width="150">
          <template #default="{ row }">
            <span class="fw-config-diff">
              {{ formatValue(auditBefore(row as AuditLogRecord).value) }} → {{ formatValue(auditAfter(row as AuditLogRecord).value) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="86" align="center">
          <template #default="{ row }">
            <el-tag :type="auditAfter(row as AuditLogRecord).ok === false ? 'danger' : 'success'" size="small">
              {{ auditAfter(row as AuditLogRecord).ok === false ? '被拒绝' : '已生效' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作者" width="80">
          <template #default="{ row }">{{ auditAfter(row as AuditLogRecord).operator ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="原因 / traceId" min-width="150">
          <template #default="{ row }">
            <template v-if="auditAfter(row as AuditLogRecord).ok === false">{{ auditAfter(row as AuditLogRecord).reason ?? '—' }}</template>
            <template v-else>{{ (row as AuditLogRecord).traceId || '—' }}</template>
          </template>
        </el-table-column>
      </el-table>
    </el-drawer>
  </div>
</template>

<style scoped>
.fw-config-meta-row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.fw-config-meta-item {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.fw-config-value {
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;
  word-break: break-all;
}

.fw-config-diff {
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;
  word-break: break-all;
}
</style>

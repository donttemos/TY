<!--
 * @file 后台任务条（N-02）
 * @description 常驻在内容区底部的任务进度条：派发导出 / 迁移等长任务后不阻塞页面，
 *   用户可继续操作或跳转别的路由；任务条展示每个任务的进度百分比、状态、失败原因与 traceId，
 *   完成后可下载、失败可重试。展开态与收起态共存（默认收起成一行胶囊）。
 *   轮询与退避逻辑在 composables/useJobCenter.ts（本组件只做展示与交互）。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-16 donttemo M10 E-15：上投影改令牌 --fw-shadow-up（暗色下 rgba 阴影需加深，
 *   写死浅色阴影在暗色底上不可见）
 * @module admin-web/layout
-->

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useJobCenterStore, isFinished, type TrackedJob } from '@/composables/useJobCenter';
import { useUserStore } from '@/store/user';

const jobCenter = useJobCenterStore();
const user = useUserStore();

/** 挂载即接管：恢复上一个会话（含刷新前）登记的任务并继续轮询 */
onMounted(() => {
  const id = user.profile?.id;
  if (id) jobCenter.restore(id);
});

/** 换号 / 登录态变化：换人重建登记表，登出清空（避免把上一个账号的任务标题留在页面上） */
watch(
  () => ({ id: user.profile?.id, loggedIn: user.isLoggedIn }),
  (next) => {
    if (next.loggedIn && next.id) jobCenter.restore(next.id);
    else if (!next.loggedIn) jobCenter.reset();
  },
);

onBeforeUnmount(() => {
  // 只停轮询，不清登记表：布局卸载（如进入登录页）后重新挂载仍能继续
  jobCenter.stop();
});

/** 状态 → 标签文案与颜色 */
function statusLabel(status: TrackedJob['status']): string {
  return { pending: '排队中', running: '进行中', succeeded: '已完成', failed: '失败' }[status];
}

function statusType(status: TrackedJob['status']): 'primary' | 'success' | 'danger' | 'info' {
  return ({ pending: 'info', running: 'primary', succeeded: 'success', failed: 'danger' } as const)[status];
}

/** el-progress 状态：失败显示异常色，成功显示成功色，其余默认 */
function progressStatus(job: TrackedJob): 'success' | 'exception' | undefined {
  if (job.status === 'failed') return 'exception';
  if (job.status === 'succeeded') return 'success';
  return undefined;
}

function onDownload(job: TrackedJob): void {
  void jobCenter.download(job.id, job.fileName);
}

function onRetry(job: TrackedJob): void {
  void jobCenter.retry(job.id).catch(() => {
    // 错误提示已在 store 内统一给出
  });
}

function onResume(job: TrackedJob): void {
  void jobCenter.resume(job.id);
}

function copyTraceId(traceId: string): void {
  void navigator.clipboard.writeText(traceId).then(() => ElMessage.success('traceId 已复制'));
}
</script>

<template>
  <div v-if="jobCenter.visible" class="fw-jobbar" :class="{ 'fw-jobbar-expanded': !jobCenter.collapsed }">
    <!-- 汇总行（点击展开 / 收起） -->
    <div class="fw-jobbar-head" @click="jobCenter.toggle()">
      <span class="fw-jobbar-head-label">后台任务</span>
      <el-tooltip
        :content="jobCenter.sseStatus === 'open' ? '实时推送已连接（SSE）' : '实时推送不可用，已降级为轮询（1s~10s 退避）'"
        placement="top"
      >
        <span class="fw-jobbar-head-mode" :class="jobCenter.sseStatus === 'open' ? 'is-live' : 'is-poll'">
          {{ jobCenter.sseStatus === 'open' ? '实时' : '轮询' }}
        </span>
      </el-tooltip>
      <el-tag v-if="jobCenter.runningCount > 0" size="small" type="primary" effect="light">进行中 {{ jobCenter.runningCount }}</el-tag>
      <el-tag v-if="jobCenter.failedCount > 0" size="small" type="danger" effect="light">失败 {{ jobCenter.failedCount }}</el-tag>
      <el-tag v-if="jobCenter.runningCount === 0 && jobCenter.failedCount === 0" size="small" type="success" effect="light">全部完成</el-tag>
      <el-progress
        class="fw-jobbar-head-progress"
        :percentage="jobCenter.overallProgress"
        :stroke-width="6"
        :show-text="false"
      />
      <span class="fw-jobbar-head-percent">{{ jobCenter.overallProgress }}%</span>
      <span class="fw-jobbar-head-toggle">{{ jobCenter.collapsed ? '展开 ▴' : '收起 ▾' }}</span>
      <el-button
        v-if="jobCenter.failedCount === 0 && jobCenter.runningCount === 0"
        link
        size="small"
        @click.stop="jobCenter.clearFinished()"
      >清空</el-button>
    </div>

    <!-- 任务明细 -->
    <div v-if="!jobCenter.collapsed" class="fw-jobbar-list">
      <div v-for="job in jobCenter.jobs" :key="job.id" class="fw-jobbar-item">
        <div class="fw-jobbar-item-head">
          <span class="fw-jobbar-item-title" :title="job.title">{{ job.title }}</span>
          <el-tag :type="statusType(job.status)" size="small" effect="light">{{ statusLabel(job.status) }}</el-tag>
          <span v-if="job.fileName && job.status === 'succeeded'" class="fw-jobbar-item-file">{{ job.fileName }}</span>
        </div>

        <el-progress :percentage="job.progress" :status="progressStatus(job)" :stroke-width="8" />

        <p v-if="job.message" class="fw-jobbar-item-message">{{ job.message }}</p>

        <!-- 失败：原因 + traceId（便于报障），两者都展示，不只给一句「失败」 -->
        <div v-if="job.status === 'failed'" class="fw-jobbar-item-error">
          <span>{{ job.error ?? '未知错误' }}</span>
          <span v-if="job.traceId" class="fw-jobbar-trace" @click="copyTraceId(job.traceId)">traceId：{{ job.traceId }}</span>
        </div>

        <div class="fw-jobbar-item-actions">
          <el-button v-if="job.status === 'succeeded'" link type="primary" @click="onDownload(job)">下载</el-button>
          <el-button v-if="job.status === 'failed'" link type="warning" @click="onRetry(job)">重试</el-button>
          <el-button v-if="job.stale && !isFinished(job.status)" link type="warning" @click="onResume(job)">重新查询</el-button>
          <el-button link @click="jobCenter.dismiss(job.id)">移除</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fw-jobbar {
  border-top: 1px solid var(--fw-border);
  background: var(--fw-surface);
  box-shadow: var(--fw-shadow-up);
  flex-shrink: 0;
}

.fw-jobbar-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 16px;
  cursor: pointer;
  user-select: none;
}

.fw-jobbar-head-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--fw-text-1);
}

/* 进度感知方式徽标：实时（SSE 在线）/ 轮询（兜底） */
.fw-jobbar-head-mode {
  font-size: 11px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  border: 1px solid var(--fw-border);
  color: var(--fw-text-3);
}

.fw-jobbar-head-mode.is-live {
  color: var(--el-color-success);
  border-color: var(--el-color-success-light-5);
}

.fw-jobbar-head-progress {
  flex: 1;
  min-width: 80px;
  max-width: 320px;
}

.fw-jobbar-head-percent {
  font-size: 12px;
  color: var(--fw-text-2);
  min-width: 34px;
}

.fw-jobbar-head-toggle {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-color-primary);
}

.fw-jobbar-list {
  max-height: 220px;
  overflow-y: auto;
  padding: 4px 16px 12px;
  border-top: 1px dashed var(--fw-border);
}

.fw-jobbar-item {
  padding: 8px 0;
}

.fw-jobbar-item + .fw-jobbar-item {
  border-top: 1px solid var(--fw-border);
}

.fw-jobbar-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.fw-jobbar-item-title {
  font-size: 13px;
  color: var(--fw-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
}

.fw-jobbar-item-file {
  font-size: 12px;
  color: var(--fw-text-3);
}

.fw-jobbar-item-message {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--fw-text-3);
}

.fw-jobbar-item-error {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-color-danger);
}

.fw-jobbar-trace {
  color: var(--el-color-primary);
  cursor: pointer;
  font-family: monospace;
}

.fw-jobbar-item-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
</style>

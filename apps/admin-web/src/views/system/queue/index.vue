<!--
 * @file 队列管理页（T-M7-06）
 * @description PRD-007 FR-09 的运维面消费端：队列积压与状态总览、成功率与平均耗时、死信列表与重放/清理、
 *   定时任务快照与手动触发、暂停/恢复消费与清空等待队列。
 *   查看类操作需 system:queue:list，变更类需 system:queue:manage（按钮级 v-permission 仅作体验优化，
 *   服务端仍强制校验）。生产管理面在 /api/v1/admin/queue，与后端 @fw/queue 的 QueueAdminController 同源。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 补「暂停 / 恢复消费」的按钮级权限（system:queue:manage）：
 *   此前该按钮未做控制，只读角色（仅 system:queue:list）能点到并吃 3002
 * @modified 2026-10-15 donttemo 死信列表改分页消费（@fw/queue dead-letters 端点支持 page/pageSize，
 *   全量返回在死信堆积时会拖垮首屏）；页签计数取 total 而非本页条数
 * @module admin-web/views
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import * as queueApi from '@/api/queue';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { CronSnapshot, DeadLetterRecord, QueueMetrics, QueueStats } from '@/api/types';

/** 总览数据 */
const stats = ref<QueueStats | null>(null);
const metrics = ref<QueueMetrics | null>(null);
const handlers = ref<string[]>([]);
const crons = ref<CronSnapshot[]>([]);
const cronEnabled = ref(false);
const deadLetters = ref<DeadLetterRecord[]>([]);
const deadTotal = ref(0);
const deadPage = ref(1);
const deadPageSize = ref(20);
const loading = ref(false);
const acting = ref('');

/** 当前标签页 */
const activeTab = ref<'backlog' | 'dead-letters' | 'crons'>('backlog');

/** 死信详情抽屉 */
const detailVisible = ref(false);
const detail = ref<DeadLetterRecord | null>(null);

/** 顶部概览卡（派生自 stats + metrics） */
const overview = computed(() => [
  { label: '驱动', value: stats.value?.driver ?? '—', raw: true },
  { label: '积压（waiting+active）', value: stats.value?.totals.backlog ?? 0 },
  { label: '执行中', value: stats.value?.totals.active ?? 0 },
  { label: '死信积压', value: stats.value?.totals.deadLetter ?? 0, danger: (stats.value?.totals.deadLetter ?? 0) > 0 },
  { label: '成功执行', value: metrics.value?.succeeded ?? 0 },
  { label: '失败（含重试）', value: metrics.value?.failed ?? 0 },
  { label: '成功率', value: `${((metrics.value?.successRate ?? 0) * 100).toFixed(1)}%` },
  { label: '平均耗时', value: `${metrics.value?.avgDurationMs ?? 0} ms` },
]);

/** 拉取全部数据（单项失败不阻塞整体） */
async function loadAll(): Promise<void> {
  loading.value = true;
  try {
    const [statsResult, metricsResult, handlersResult, cronsResult] = await Promise.all([
      queueApi.fetchQueueStats().catch(() => null),
      queueApi.fetchQueueMetrics().catch(() => null),
      queueApi.fetchQueueHandlers().catch(() => null),
      queueApi.fetchCrons().catch(() => null),
    ]);
    stats.value = statsResult;
    metrics.value = metricsResult;
    handlers.value = handlersResult?.names ?? [];
    crons.value = cronsResult?.items ?? [];
    cronEnabled.value = cronsResult?.enabled ?? false;
    await loadDeadLetters();
  } finally {
    loading.value = false;
  }
}

/** 死信分页（翻页只拉死信，不动其余面板） */
async function loadDeadLetters(): Promise<void> {
  const result = await queueApi.fetchDeadLetters(undefined, deadPage.value, deadPageSize.value).catch(() => null);
  deadLetters.value = result?.items ?? [];
  deadTotal.value = result?.total ?? 0;
}

onMounted(() => {
  void loadAll();
});

/** 统一动作包装：加载态 + 成功提示 + 错误提示 + 刷新 */
async function run(key: string, label: string, action: () => Promise<unknown>): Promise<void> {
  acting.value = key;
  try {
    await action();
    ElMessage.success(`${label}成功`);
    await loadAll();
  } catch (error) {
    ElMessage.error(error instanceof BizError ? describeBizError(error) : `${label}失败`);
  } finally {
    acting.value = '';
  }
}

/** 暂停 / 恢复消费 */
function toggleConsume(): void {
  if (!stats.value) return;
  const paused = stats.value.paused;
  void run('toggle', paused ? '恢复消费' : '暂停消费', () => (paused ? queueApi.resumeQueue() : queueApi.pauseQueue()));
}

/** 清空等待中的任务（二次确认） */
async function drain(): Promise<void> {
  try {
    await ElMessageBox.confirm('将清空所有队列中等待执行的任务，执行中的任务不受影响。确认继续？', '清空等待队列', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  await run('drain', '清空等待队列', () => queueApi.drainQueue());
}

/** 清理死信（二次确认） */
async function purge(): Promise<void> {
  try {
    await ElMessageBox.confirm('将删除全部死信记录，删除后不可恢复。确认继续？', '清理死信', {
      type: 'warning',
      confirmButtonText: '清理',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  await run('purge', '清理死信', () => queueApi.purgeDeadLetters());
}

/** 重放单条死信 */
function requeue(row: DeadLetterRecord): void {
  void run(`requeue-${row.id}`, '重放死信', () => queueApi.requeueDeadLetter(row.id));
}

/** 手动触发定时任务（仍走分布式锁） */
function tick(row: CronSnapshot): void {
  void run(`tick-${row.name}`, `触发 ${row.name}`, () => queueApi.tickCron(row.name));
}

function openDetail(row: DeadLetterRecord): void {
  detail.value = row;
  detailVisible.value = true;
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function formatPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}
</script>

<template>
  <div class="fw-page" v-loading="loading">
    <!-- 概览 -->
    <div class="fw-card">
      <div class="fw-queue-head">
        <div>
          <h3 class="fw-queue-title">队列状态</h3>
          <p class="fw-text-secondary">
            消费状态：<el-tag :type="stats?.paused ? 'warning' : 'success'" size="small" effect="light">{{ stats?.paused ? '已暂停' : '运行中' }}</el-tag>
            ｜ 已注册任务 {{ handlers.length }} 个 ｜ 定时任务 {{ crons.length }} 个（{{ cronEnabled ? '已启用' : '已停用' }}）
          </p>
        </div>
        <div class="fw-queue-actions">
          <el-button
            v-permission="'system:queue:manage'"
            :loading="acting === 'toggle'"
            @click="toggleConsume()"
          >{{ stats?.paused ? '恢复消费' : '暂停消费' }}</el-button>
          <el-button :loading="acting === 'drain'" v-permission="'system:queue:manage'" @click="drain()">清空等待</el-button>
          <el-button :loading="loading" type="primary" @click="loadAll()">刷新</el-button>
        </div>
      </div>

      <div class="fw-queue-stats">
        <div v-for="item in overview" :key="item.label" class="fw-queue-stat">
          <div class="fw-queue-stat-value" :class="{ 'fw-queue-stat-danger': item.danger }">{{ item.value }}</div>
          <div class="fw-text-weak">{{ item.label }}</div>
        </div>
      </div>
    </div>

    <!-- 明细 -->
    <div class="fw-card">
      <el-tabs v-model="activeTab">
        <!-- 队列积压 -->
        <el-tab-pane name="backlog">
          <template #label>队列积压（{{ stats?.queues.length ?? 0 }}）</template>
          <el-table :data="stats?.queues ?? []" border stripe size="small">
            <el-table-column prop="name" label="队列" min-width="140" />
            <el-table-column prop="waiting" label="等待" width="90" align="center" />
            <el-table-column prop="active" label="执行中" width="90" align="center" />
            <el-table-column prop="backlog" label="积压" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="row.backlog > 0 ? 'warning' : 'info'" size="small" effect="light">{{ row.backlog }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="completed" label="已完成" width="100" align="center" />
            <el-table-column prop="deadLetter" label="死信" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="row.deadLetter > 0 ? 'danger' : 'info'" size="small" effect="light">{{ row.deadLetter }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="concurrency" label="并发" width="90" align="center" />
            <el-table-column label="限速" width="110" align="center">
              <template #default="{ row }">{{ row.rateLimit > 0 ? `${row.rateLimit}/s` : '不限' }}</template>
            </el-table-column>
            <template #empty>暂无队列</template>
          </el-table>
        </el-tab-pane>

        <!-- 死信 -->
        <el-tab-pane name="dead-letters">
          <template #label>死信（{{ deadTotal }}）</template>
          <div class="fw-queue-tab-bar">
            <el-button v-permission="'system:queue:manage'" :loading="acting === 'purge'" type="danger" plain @click="purge()">清理全部死信</el-button>
          </div>
          <el-table :data="deadLetters" border stripe size="small">
            <el-table-column prop="id" label="任务 ID" width="170" />
            <el-table-column prop="name" label="任务名" min-width="150" />
            <el-table-column prop="queue" label="队列" width="110" />
            <el-table-column prop="attemptsMade" label="已执行" width="90" align="center" />
            <el-table-column prop="reason" label="失败原因" min-width="220" show-overflow-tooltip />
            <el-table-column label="失败时间" width="180">
              <template #default="{ row }">{{ formatTime(row.failedAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openDetail(row)">详情</el-button>
                <el-button v-permission="'system:queue:manage'" link type="primary" :loading="acting === `requeue-${row.id}`" @click="requeue(row)">重放</el-button>
              </template>
            </el-table-column>
            <template #empty>暂无死信</template>
          </el-table>
          <div v-if="deadTotal > 0" class="fw-queue-pagination">
            <span class="fw-text-weak">共 {{ deadTotal }} 条</span>
            <el-pagination
              :current-page="deadPage"
              :page-size="deadPageSize"
              :total="deadTotal"
              layout="prev, pager, next"
              background
              small
              @current-change="(next: number) => { deadPage = next; void loadDeadLetters(); }"
            />
          </div>
        </el-tab-pane>

        <!-- 定时任务 -->
        <el-tab-pane name="crons">
          <template #label>定时任务（{{ crons.length }}）</template>
          <el-table :data="crons" border stripe size="small">
            <el-table-column prop="name" label="任务名" min-width="150" />
            <el-table-column prop="expression" label="表达式" width="150" />
            <el-table-column label="互斥" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="row.lock ? 'success' : 'info'" size="small" effect="light">{{ row.lock ? '加锁' : '不加锁' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="下次触发" width="180">
              <template #default="{ row }">{{ formatTime(row.nextRunAt) }}</template>
            </el-table-column>
            <el-table-column prop="runs" label="本实例执行" width="110" align="center" />
            <el-table-column prop="lockedOut" label="抢锁失败" width="100" align="center" />
            <el-table-column label="最近结果" width="110" align="center">
              <template #default="{ row }">
                <el-tag v-if="row.lastResult" :type="row.lastResult === 'ok' ? 'success' : 'danger'" size="small" effect="light">{{ row.lastResult }}</el-tag>
                <span v-else class="fw-text-weak">—</span>
              </template>
            </el-table-column>
            <el-table-column label="最近执行" width="180">
              <template #default="{ row }">{{ formatTime(row.lastRunAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="110" fixed="right">
              <template #default="{ row }">
                <el-button v-permission="'system:queue:manage'" link type="primary" :loading="acting === `tick-${row.name}`" @click="tick(row)">手动触发</el-button>
              </template>
            </el-table-column>
            <template #empty>暂无定时任务</template>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>

    <!-- 死信详情 -->
    <el-drawer v-model="detailVisible" title="死信详情" size="560px">
      <template v-if="detail">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="任务 ID">{{ detail.id }}</el-descriptions-item>
          <el-descriptions-item label="任务名">{{ detail.name }}</el-descriptions-item>
          <el-descriptions-item label="队列">{{ detail.queue }}</el-descriptions-item>
          <el-descriptions-item label="已执行次数">{{ detail.attemptsMade }}</el-descriptions-item>
          <el-descriptions-item label="入队时间">{{ formatTime(detail.enqueuedAt) }}</el-descriptions-item>
          <el-descriptions-item label="失败时间">{{ formatTime(detail.failedAt) }}</el-descriptions-item>
          <el-descriptions-item label="失败原因" :span="2">{{ detail.reason }}</el-descriptions-item>
          <el-descriptions-item label="载荷" :span="2">
            <pre class="fw-queue-payload">{{ formatPayload(detail.payload) }}</pre>
          </el-descriptions-item>
        </el-descriptions>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.fw-queue-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.fw-queue-title {
  margin: 0 0 8px;
  font-size: 16px;
}

.fw-queue-actions {
  display: flex;
  gap: 8px;
}

.fw-queue-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.fw-queue-stat {
  text-align: center;
  padding: 12px;
  border: 1px solid var(--fw-border);
  border-radius: 8px;
}

.fw-queue-stat-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.fw-queue-stat-danger {
  color: var(--el-color-danger);
}

.fw-queue-tab-bar {
  margin-bottom: 12px;
}

.fw-queue-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 12px;
}

.fw-queue-payload {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>

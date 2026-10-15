/*
 * @file 异步任务中心（N-02 前端数据源）
 * @description 承载「派发 → 轮询进度 → 完成下载 / 失败重试」的完整前端生命周期，供全局任务条
 *   （layout/JobBar.vue）消费。设计要点：
 *   - **不阻塞页面**：任务由业务页派发后只登记 id，进度轮询在全局单例里进行，页面可继续操作或跳走；
 *   - **失败不丢任务**：单次轮询失败只累计计数，不删除登记项；连续失败超过阈值才标记 `stale`
 *     并停止对该任务打点（避免对已过期任务无限请求），任务仍留在任务条上可手动重试；
 *   - **轮询退避**：任一轮有进展即回到基准间隔（1s），无进展则按系数放大并封顶 10s，避免空转；
 *   - **刷新不丢**：登记项落 sessionStorage（按用户隔离），页面刷新后重新挂载轮询继续跟踪。
 *
 *   诚实说明：任务本体在**后端进程内存**（见 example-api 的 JobCenterService），后端重启会丢任务；
 *   此时前端轮询会连续 404 → 标记 stale 并提示「已过期」，而不是静默消失。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/composables
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import * as jobApi from '@/api/job';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { JobView } from '@/api/types';

/** 基准轮询间隔（毫秒） */
export const POLL_BASE_MS = 1000;

/** 轮询间隔上限：长时间无进展时降频至此 */
export const POLL_MAX_MS = 10_000;

/** 无进展时的间隔放大系数 */
export const POLL_BACKOFF = 1.5;

/** 单任务连续轮询失败上限，达到后停止轮询 */
export const POLL_MAX_FAILURES = 3;

/** 持久化键（任务登记表按用户隔离，避免换号后看到上一个账号的任务标题） */
const STORAGE_KEY = 'fw_job_center';

/**
 * 轮询退避（纯函数，便于单测）
 * @param current 当前间隔（毫秒）
 * @param progressed 本轮是否有任务进度发生变化
 * @returns 下一轮间隔
 */
export function nextPollInterval(current: number, progressed: boolean): number {
  if (progressed) return POLL_BASE_MS;
  return Math.min(POLL_MAX_MS, Math.round(current * POLL_BACKOFF));
}

/** 是否终态（终态不再轮询） */
export function isFinished(status: JobView['status']): boolean {
  return status === 'succeeded' || status === 'failed';
}

/** 任务条登记项：契约 JobView + 两个本地态字段 */
export interface TrackedJob extends JobView {
  /** 连续轮询失败次数 */
  pollFailures: number;
  /** 已停止轮询（任务过期 / 连续失败）：保留在任务条上，不静默丢弃 */
  stale: boolean;
}

/** 持久化载荷 */
interface PersistedJobs {
  owner: string;
  jobs: TrackedJob[];
}

export const useJobCenterStore = defineStore('job-center', () => {
  /** 任务登记表（新任务在前） */
  const jobs = ref<TrackedJob[]>([]);
  /** 任务条折叠态（默认收起，避免遮挡内容区） */
  const collapsed = ref(true);

  /** 登记表归属人（未登录 / 未初始化时为 null） */
  let ownerId: string | null = null;
  /** 轮询定时器（window.setTimeout 的返回值，非 Node 的 Timeout） */
  let timer: number | null = null;
  /** 当前轮询间隔（随退避变化） */
  let interval = POLL_BASE_MS;
  /** 终态提示去重（避免重跑后再次提示被抑制、以及重复提示） */
  const notified = new Set<string>();
  /** restore 只生效一次（JobBar 每次挂载都会调） */
  let restored = false;

  /** 进行中的任务（未终态且未停止轮询） */
  const activeJobs = computed(() => jobs.value.filter((job) => !isFinished(job.status) && !job.stale));

  /** 任务条是否可见 */
  const visible = computed(() => jobs.value.length > 0);

  /** 进行中数量 */
  const runningCount = computed(() => activeJobs.value.length);

  /** 失败数量（未重跑的） */
  const failedCount = computed(() => jobs.value.filter((job) => job.status === 'failed').length);

  /** 总体进度（仅统计进行中任务的平均值；无进行中任务时取已完成占比） */
  const overallProgress = computed(() => {
    const active = activeJobs.value;
    if (active.length > 0) {
      return Math.round(active.reduce((sum, job) => sum + job.progress, 0) / active.length);
    }
    if (jobs.value.length === 0) return 0;
    const done = jobs.value.filter((job) => job.status === 'succeeded').length;
    return Math.round((done / jobs.value.length) * 100);
  });

  /** 持久化（失败降级为仅内存，不影响功能） */
  function persist(): void {
    if (typeof sessionStorage === 'undefined' || ownerId === null) return;
    try {
      const payload: PersistedJobs = { owner: ownerId, jobs: jobs.value };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // 隐私模式 / 超配额：降级为仅内存
    }
  }

  /** 写入登记表（同 id 覆盖，保留本地态字段除非显式指定） */
  function upsert(view: JobView, resetLocal = false): void {
    const index = jobs.value.findIndex((job) => job.id === view.id);
    if (index === -1) {
      jobs.value.unshift({ ...view, pollFailures: 0, stale: false });
      return;
    }
    const current = jobs.value[index] as TrackedJob;
    const pollFailures = resetLocal ? 0 : current.pollFailures;
    const stale = resetLocal ? false : current.stale;
    jobs.value[index] = { ...current, ...view, pollFailures, stale };
  }

  /** 终态提示（每次派发/重跑只提示一次） */
  function notifyFinished(view: JobView): void {
    if (notified.has(view.id)) return;
    notified.add(view.id);
    if (view.status === 'succeeded') {
      ElMessage.success(`${view.title}：已完成${view.fileName ? '，可下载' : ''}`);
    } else if (view.status === 'failed') {
      ElMessage.error(`${view.title}：失败（${view.error ?? '未知原因'}）`);
    }
  }

  /** 调度下一轮（无进行中任务时不排期） */
  function schedule(): void {
    if (timer !== null || typeof window === 'undefined') return;
    if (activeJobs.value.length === 0) return;
    timer = window.setTimeout(() => void tick(), interval);
  }

  /** 停止轮询（登出 / 组件销毁） */
  function stop(): void {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    interval = POLL_BASE_MS;
  }

  /**
   * 轮询一轮
   * @returns 是否有任务进度发生变化（供退避决策）
   */
  async function pollOnce(): Promise<boolean> {
    const targets = activeJobs.value.map((job) => job.id);
    if (targets.length === 0) return false;
    let progressed = false;
    await Promise.all(
      targets.map(async (id) => {
        const current = jobs.value.find((job) => job.id === id);
        if (!current) return;
        try {
          const next = await jobApi.fetchJobProgress(id);
          if (next.progress !== current.progress || next.status !== current.status) progressed = true;
          upsert(next, true);
          if (isFinished(next.status)) notifyFinished(next);
        } catch {
          // 单次失败不丢任务：可能是网络抖动或 401 无感刷新中，下一轮继续
          current.pollFailures += 1;
          if (current.pollFailures >= POLL_MAX_FAILURES) {
            current.stale = true;
            current.message = '进度查询连续失败，已停止轮询（任务可能已过期）';
          }
        }
      }),
    );
    return progressed;
  }

  /** 定时器回调：轮询 → 按结果调间隔 → 续期 → 落盘 */
  async function tick(): Promise<void> {
    timer = null;
    if (activeJobs.value.length === 0) {
      interval = POLL_BASE_MS;
      persist();
      return;
    }
    const progressed = await pollOnce();
    interval = nextPollInterval(interval, progressed);
    persist();
    schedule();
  }

  /**
   * 初始化（JobBar 挂载时调用）
   * @param currentUserId 当前登录用户 id（用于隔离持久化数据）
   */
  function restore(currentUserId: string): void {
    if (restored && ownerId === currentUserId) return;
    restored = true;
    ownerId = currentUserId;
    if (typeof sessionStorage !== 'undefined') {
      try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as PersistedJobs;
          if (saved.owner === currentUserId && Array.isArray(saved.jobs)) {
            // 重新挂轮询：持久化的 stale 标记不带过来（本次会话应再试一次），
            // 后端已重启时自然会在 3 次失败后重新标记为 stale
            jobs.value = saved.jobs.map((job) => ({ ...job, pollFailures: 0, stale: false }));
          } else {
            // 换号 / 快照不属于当前用户：重建登记表——只删存储不清内存会残留上一个账号的任务
            jobs.value = [];
            sessionStorage.removeItem(STORAGE_KEY);
          }
        } else {
          jobs.value = [];
        }
      } catch {
        // 损坏的持久化数据直接忽略
      }
    }
    interval = POLL_BASE_MS;
    schedule();
  }

  /** 重置（登出）：清空登记表与持久化 */
  function reset(): void {
    stop();
    jobs.value = [];
    notified.clear();
    ownerId = null;
    restored = false;
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 登记新派发的任务（页面点「导出」拿到 jobId 后调用）
   * @param view 后端返回的任务视图
   */
  function track(view: JobView): void {
    notified.delete(view.id);
    upsert(view, true);
    interval = POLL_BASE_MS;
    persist();
    schedule();
  }

  /** 失败任务原地重跑 */
  async function retry(id: string): Promise<void> {
    try {
      const view = await jobApi.retryJob(id);
      notified.delete(id);
      upsert(view, true);
      interval = POLL_BASE_MS;
      persist();
      schedule();
    } catch (error) {
      ElMessage.error(error instanceof BizError ? describeBizError(error) : '重试失败，请稍后重试');
      throw error;
    }
  }

  /** 下载任务产物 */
  async function download(id: string, fileName?: string | null): Promise<void> {
    const job = jobs.value.find((item) => item.id === id);
    try {
      await jobApi.downloadJob(id, fileName ?? job?.fileName ?? undefined);
    } catch (error) {
      ElMessage.error(error instanceof BizError ? describeBizError(error) : '下载失败，请稍后重试');
      throw error;
    }
  }

  /** 移出任务条（不删除后端任务） */
  function dismiss(id: string): void {
    jobs.value = jobs.value.filter((job) => job.id !== id);
    notified.delete(id);
    persist();
  }

  /** 清空已结束的任务 */
  function clearFinished(): void {
    jobs.value = jobs.value.filter((job) => !isFinished(job.status));
    persist();
  }

  /** 立即轮询一次（手动刷新按钮） */
  async function refreshNow(): Promise<void> {
    await pollOnce();
    persist();
    schedule();
  }

  /**
   * 恢复对已停止轮询任务的跟踪（任务条上的「重新查询」）
   *
   * 与 `retry` 的区别：`retry` 是让**后端重跑**（仅失败任务合法，运行中重跑会被 400/1004 拒绝）；
   * 本函数只是前端重新开始打点，适用于「连续失败被标记 stale 但任务其实还在跑」的场景。
   */
  async function resume(id: string): Promise<void> {
    const job = jobs.value.find((item) => item.id === id);
    if (!job) return;
    job.stale = false;
    job.pollFailures = 0;
    interval = POLL_BASE_MS;
    await refreshNow();
  }

  /** 展开 / 收起 */
  function toggle(): void {
    collapsed.value = !collapsed.value;
  }

  return {
    jobs,
    collapsed,
    visible,
    activeJobs,
    runningCount,
    failedCount,
    overallProgress,
    restore,
    reset,
    track,
    retry,
    download,
    dismiss,
    clearFinished,
    refreshNow,
    resume,
    toggle,
    stop,
  };
});

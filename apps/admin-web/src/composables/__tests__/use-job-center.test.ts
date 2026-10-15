/*
 * @file 异步任务中心 store 单元测试（N-02 前端）
 * @description 覆盖任务条数据源契约：轮询退避纯函数（有进展回基准 / 无进展按系数放大并封顶）、
 *   终态判定、派发登记（新任务在前 + 持久化）、按用户隔离恢复（换号不串任务）、
 *   单次轮询失败不丢任务（累计到阈值才标 stale）、retry / download 委托与错误提示。
 *   轮询定时器在用例内即时消费（tick 由测试手动驱动或等待自然到期），不遗留悬挂定时器。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/composables
 */

import { setActivePinia, createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElMessage } from 'element-plus';

/** 任务 API 全部 mock 掉：store 只验证编排逻辑，不发真实请求 */
vi.mock('@/api/job', () => ({
  fetchJobProgress: vi.fn(),
  retryJob: vi.fn(),
  downloadJob: vi.fn(),
}));

import * as jobApi from '@/api/job';
import { POLL_BACKOFF, POLL_BASE_MS, POLL_MAX_FAILURES, POLL_MAX_MS, isFinished, nextPollInterval, useJobCenterStore } from '../useJobCenter';
import type { JobView } from '@/api/types';

/** 构造任务视图 */
function makeJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    type: 'audit.export',
    title: '审计日志导出（10 条）',
    status: 'running',
    progress: 40,
    message: '执行中',
    error: null,
    traceId: 'trace-1',
    fileName: null,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:01.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close: vi.fn() }) as unknown as ReturnType<typeof ElMessage.success>);
  vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close: vi.fn() }) as unknown as ReturnType<typeof ElMessage.error>);
});

describe('轮询退避（纯函数）', () => {
  it('有进展回到基准间隔', () => {
    expect(nextPollInterval(POLL_MAX_MS, true)).toBe(POLL_BASE_MS);
  });

  it('无进展按系数放大，封顶 10s', () => {
    let interval = POLL_BASE_MS;
    const steps: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      interval = nextPollInterval(interval, false);
      steps.push(interval);
    }
    expect(steps[0]).toBe(Math.round(POLL_BASE_MS * POLL_BACKOFF));
    expect(Math.max(...steps)).toBe(POLL_MAX_MS);
    // 封顶后不再增长
    expect(steps[steps.length - 1]).toBe(POLL_MAX_MS);
  });

  it('终态判定：succeeded / failed 为终态', () => {
    expect(isFinished('succeeded')).toBe(true);
    expect(isFinished('failed')).toBe(true);
    expect(isFinished('running')).toBe(false);
    expect(isFinished('pending')).toBe(false);
  });
});

describe('useJobCenterStore', () => {
  it('track 登记新任务（置顶）并落盘；visible / runningCount 派生正确', () => {
    const store = useJobCenterStore();
    store.track(makeJob({ id: 'job-1', status: 'running', progress: 0 }));
    store.track(makeJob({ id: 'job-2', status: 'pending', progress: 0, title: '第二个任务' }));

    expect(store.jobs.map((job) => job.id)).toEqual(['job-2', 'job-1']);
    expect(store.visible).toBe(true);
    expect(store.runningCount).toBe(2);
    expect(store.overallProgress).toBe(0);
    // 持久化按 owner 隔离：未 restore 前 ownerId 为 null，不写盘
    expect(sessionStorage.getItem('fw_job_center')).toBeNull();
  });

  it('restore 按用户隔离：只恢复同 owner 的快照，换号清空旧数据', () => {
    const store = useJobCenterStore();
    store.restore('u-1');
    store.track(makeJob({ id: 'job-1', status: 'running', progress: 50 }));
    expect(sessionStorage.getItem('fw_job_center')).toContain('u-1');

    // 同一会话重复 restore 不重置登记表（JobBar 每次挂载都会调）
    store.restore('u-1');
    expect(store.jobs).toHaveLength(1);

    // 换号：重建登记表（不残留上一个账号的任务），旧快照删除
    store.restore('u-2');
    expect(store.jobs).toHaveLength(0);
    expect(sessionStorage.getItem('fw_job_center')).toBeNull();
  });

  it('刷新恢复的 stale 不带过来：本次会话重新打点', () => {
    sessionStorage.setItem(
      'fw_job_center',
      JSON.stringify({ owner: 'u-1', jobs: [{ ...makeJob(), pollFailures: 3, stale: true }] }),
    );
    const store = useJobCenterStore();
    store.restore('u-1');
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]?.stale).toBe(false);
    expect(store.jobs[0]?.pollFailures).toBe(0);
  });

  it('轮询推进进度：成功后进入终态并只提示一次', async () => {
    const store = useJobCenterStore();
    store.restore('u-1');
    store.track(makeJob({ id: 'job-1', status: 'running', progress: 40 }));

    vi.mocked(jobApi.fetchJobProgress).mockResolvedValueOnce(makeJob({ id: 'job-1', status: 'succeeded', progress: 100, fileName: 'audit.csv', message: '已完成，可下载' }));
    await store.refreshNow();
    expect(store.jobs[0]?.status).toBe('succeeded');
    expect(store.jobs[0]?.progress).toBe(100);
    expect(store.jobs[0]?.fileName).toBe('audit.csv');
    expect(ElMessage.success).toHaveBeenCalledTimes(1);

    // 终态任务不再计入进行中；再次轮询无目标
    expect(store.runningCount).toBe(0);
    expect(store.overallProgress).toBe(100);
  });

  it('连续失败不丢任务：累计到阈值才标 stale 并给出可读 message', async () => {
    const store = useJobCenterStore();
    store.restore('u-1');
    store.track(makeJob({ id: 'job-1', status: 'running', progress: 20 }));

    vi.mocked(jobApi.fetchJobProgress).mockRejectedValue(new Error('网络波动'));
    for (let i = 0; i < POLL_MAX_FAILURES - 1; i += 1) {
      await store.refreshNow();
      expect(store.jobs[0]?.stale).toBe(false);
      expect(store.jobs[0]?.pollFailures).toBe(i + 1);
    }
    await store.refreshNow();
    expect(store.jobs[0]?.stale).toBe(true);
    expect(store.jobs[0]?.message).toContain('已停止轮询');
    // stale 后不再参与轮询
    expect(store.runningCount).toBe(0);
  });

  it('resume：重新打点后该任务继续参与轮询', async () => {
    const store = useJobCenterStore();
    store.restore('u-1');
    store.track(makeJob({ id: 'job-1', status: 'running', progress: 20 }));
    vi.mocked(jobApi.fetchJobProgress).mockRejectedValue(new Error('网络波动'));
    for (let i = 0; i < POLL_MAX_FAILURES; i += 1) await store.refreshNow();
    expect(store.jobs[0]?.stale).toBe(true);

    vi.mocked(jobApi.fetchJobProgress).mockResolvedValue(makeJob({ id: 'job-1', status: 'running', progress: 60 }));
    await store.resume('job-1');
    expect(store.jobs[0]?.stale).toBe(false);
    expect(store.jobs[0]?.progress).toBe(60);
  });

  it('retry：委托 retryJob 并重置本地态；失败给出错误提示且重新抛出', async () => {
    const store = useJobCenterStore();
    store.restore('u-1');
    store.track(makeJob({ id: 'job-1', status: 'failed', progress: 60, error: '下游超时' }));

    vi.mocked(jobApi.retryJob).mockResolvedValueOnce(makeJob({ id: 'job-1', status: 'pending', progress: 0, error: null, message: '已重新派发' }));
    await store.retry('job-1');
    expect(jobApi.retryJob).toHaveBeenCalledWith('job-1');
    expect(store.jobs[0]?.status).toBe('pending');
    expect(store.jobs[0]?.progress).toBe(0);
    expect(store.jobs[0]?.error).toBeNull();

    vi.mocked(jobApi.retryJob).mockRejectedValueOnce(new Error('任务已成功，无需重跑'));
    await expect(store.retry('job-1')).rejects.toThrow('任务已成功，无需重跑');
    expect(ElMessage.error).toHaveBeenCalledTimes(1);
  });

  it('download：按任务条上的文件名委托下载；失败提示并抛出', async () => {
    const store = useJobCenterStore();
    store.restore('u-1');
    store.track(makeJob({ id: 'job-1', status: 'succeeded', progress: 100, fileName: 'audit-logs-20261015.csv' }));

    await store.download('job-1');
    expect(jobApi.downloadJob).toHaveBeenCalledWith('job-1', 'audit-logs-20261015.csv');

    vi.mocked(jobApi.downloadJob).mockRejectedValueOnce(new Error('产物已过期'));
    await expect(store.download('job-1')).rejects.toThrow('产物已过期');
    expect(ElMessage.error).toHaveBeenCalledTimes(1);
  });

  it('dismiss / clearFinished / reset 语义', () => {
    const store = useJobCenterStore();
    store.restore('u-1');
    store.track(makeJob({ id: 'job-1', status: 'succeeded', progress: 100 }));
    store.track(makeJob({ id: 'job-2', status: 'failed', progress: 30, error: 'boom' }));
    store.track(makeJob({ id: 'job-3', status: 'running', progress: 50 }));

    store.dismiss('job-2');
    expect(store.jobs.map((job) => job.id)).toEqual(['job-3', 'job-1']);

    store.clearFinished();
    expect(store.jobs.map((job) => job.id)).toEqual(['job-3']);
    expect(store.failedCount).toBe(0);

    store.reset();
    expect(store.jobs).toHaveLength(0);
    expect(store.visible).toBe(false);
    expect(sessionStorage.getItem('fw_job_center')).toBeNull();
  });
});

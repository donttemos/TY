/*
 * @file 异步任务中心 store 的 SSE 集成单测（M10 E-12 / E-13）
 * @description 覆盖「实时优先、轮询兜底」的编排语义（E-13 起连接所有权移交 store/realtime）：
 *   启动共享连接并注册 job / queue 消费者；连接 open 后**停轮询**并改为 60s 低频对账；
 *   连接 closed 时立刻恢复轮询；事件到达即更新登记表并提示终态；登出（reset）注销消费者并关闭连接。
 *   SSE 客户端整体 mock，不打真实网络。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/composables
 */

import { setActivePinia, createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElMessage } from 'element-plus';

vi.mock('@/api/job', () => ({
  fetchJobProgress: vi.fn(),
  retryJob: vi.fn(),
  downloadJob: vi.fn(),
}));

vi.mock('@/utils/sse', () => ({ createJobEventStream: vi.fn() }));

import * as jobApi from '@/api/job';
import { createJobEventStream, type SseHandlers } from '@/utils/sse';
import { SSE_RECONCILE_MS, POLL_BASE_MS, useJobCenterStore } from '../useJobCenter';
import type { JobView } from '@/api/types';

/** 构造任务视图 */
function makeJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    type: 'audit.export',
    title: '审计日志导出',
    status: 'running',
    progress: 30,
    message: '执行中',
    error: null,
    traceId: 'trace-1',
    fileName: null,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:01.000Z',
    ...overrides,
  };
}

/** 捕获建流时传入的处理器（由 store/realtime 转交） */
let captured: SseHandlers | null = null;
const closeSpy = vi.fn();

/** 冲刷微任务（Vue watch 回调与事件分发都在微任务里） */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  vi.useRealTimers();
  captured = null;
  sessionStorage.clear();
  vi.mocked(createJobEventStream).mockImplementation((handlers: SseHandlers) => {
    captured = handlers;
    return { close: closeSpy };
  });
  vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close: vi.fn() }) as never);
  vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close: vi.fn() }) as never);
  vi.spyOn(ElMessage, 'warning').mockImplementation(() => ({ close: vi.fn() }) as never);
});

describe('useJobCenter × 实时通道：实时优先、轮询兜底', () => {
  it('restore 建共享连接；连接不可用（closed）时保持轮询', async () => {
    vi.useFakeTimers();
    const store = useJobCenterStore();
    store.restore('u1');
    expect(createJobEventStream).toHaveBeenCalledTimes(1);

    store.track(makeJob());
    vi.mocked(jobApi.fetchJobProgress).mockResolvedValue(makeJob({ progress: 60 }));

    captured?.onStatus?.('closed');
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_BASE_MS + 10);
    expect(vi.mocked(jobApi.fetchJobProgress)).toHaveBeenCalled();
    store.reset();
  });

  it('连接 open 后停轮询，仅保留 60s 低频对账', async () => {
    vi.useFakeTimers();
    const store = useJobCenterStore();
    store.restore('u1');
    store.track(makeJob());
    vi.mocked(jobApi.fetchJobProgress).mockResolvedValue(makeJob({ progress: 60 }));

    captured?.onStatus?.('open');
    await flush();
    expect(vi.mocked(jobApi.fetchJobProgress)).toHaveBeenCalledTimes(1); // 建连即对账一次

    await vi.advanceTimersByTimeAsync(POLL_BASE_MS * 10);
    expect(vi.mocked(jobApi.fetchJobProgress)).toHaveBeenCalledTimes(1); // 基准轮询已停

    await vi.advanceTimersByTimeAsync(SSE_RECONCILE_MS);
    expect(vi.mocked(jobApi.fetchJobProgress)).toHaveBeenCalledTimes(2); // 对账补齐
    store.reset();
  });

  it('job 事件直接更新登记表并在终态提示（含未登记的跨标签页任务）', async () => {
    const store = useJobCenterStore();
    store.restore('u1');

    captured?.onJob?.({ kind: 'progress', job: makeJob({ progress: 70 }), ownerId: 'u1' } as never);
    await flush();
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]?.progress).toBe(70);

    captured?.onJob?.({ kind: 'finished', job: makeJob({ status: 'succeeded', progress: 100, fileName: 'audit.csv' }), ownerId: 'u1' } as never);
    await flush();
    expect(store.jobs[0]?.status).toBe('succeeded');
    expect(ElMessage.success).toHaveBeenCalledTimes(1);

    // 同一条终态事件重复到达不重复提示
    captured?.onJob?.({ kind: 'finished', job: makeJob({ status: 'succeeded', progress: 100 }), ownerId: 'u1' } as never);
    await flush();
    expect(ElMessage.success).toHaveBeenCalledTimes(1);
    store.reset();
  });

  it('queue 告警按类型提示（死信 → error；积压 → warning）', async () => {
    const store = useJobCenterStore();
    store.restore('u1');
    captured?.onQueue?.({ kind: 'dead-letter', at: 'now', jobName: 'audit.export', reason: 'boom' } as never);
    await flush();
    expect(ElMessage.error).toHaveBeenCalledTimes(1);
    captured?.onQueue?.({ kind: 'backlog', at: 'now', waiting: 150, threshold: 100 } as never);
    await flush();
    expect(ElMessage.warning).toHaveBeenCalledTimes(1);
    store.reset();
  });

  it('reset（登出）关闭连接并清空登记表', () => {
    const store = useJobCenterStore();
    store.restore('u1');
    store.track(makeJob());
    expect(store.jobs).toHaveLength(1);
    store.reset();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(store.jobs).toHaveLength(0);
  });
});

/*
 * @file 实时通道 store 单测（M10 E-12 / E-13）
 * @description 覆盖「单连接多消费者」语义：多次 start 只建一条事件流、按事件类型分发到各消费者、
 *   消费者异常相互隔离、退订后不再收到、状态变化透出、stop 后连接关闭且可重新 start。
 *   SSE 客户端整体 mock，不打真实网络（连接细节由 utils/__tests__/sse.test.ts 覆盖）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/store
 */

import { setActivePinia, createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/sse', () => ({ createJobEventStream: vi.fn() }));

import { createJobEventStream, type SseHandlers } from '@/utils/sse';
import { useRealtimeStore } from '../realtime';

/** 捕获建流时的处理器，便于测试内驱动事件 */
let captured: SseHandlers | null = null;
const closeSpy = vi.fn();

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  captured = null;
  vi.mocked(createJobEventStream).mockImplementation((handlers: SseHandlers) => {
    captured = handlers;
    return { close: closeSpy };
  });
});

describe('useRealtimeStore：单连接多消费者', () => {
  it('多次 start 只建一条连接（幂等），stop 后关闭并可重新建立', () => {
    const realtime = useRealtimeStore();
    realtime.start();
    realtime.start();
    expect(createJobEventStream).toHaveBeenCalledTimes(1);

    realtime.stop();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    realtime.start();
    expect(createJobEventStream).toHaveBeenCalledTimes(2);
    realtime.stop();
  });

  it('按事件类型分发：job / notification / queue 各归各的消费者', () => {
    const realtime = useRealtimeStore();
    const jobs: unknown[] = [];
    const notices: unknown[] = [];
    const alerts: unknown[] = [];
    realtime.on('job', (payload) => jobs.push(payload));
    realtime.on('notification', (payload) => notices.push(payload));
    realtime.on('queue', (payload) => alerts.push(payload));
    realtime.start();

    captured?.onJob?.({ kind: 'progress', ownerId: 'u1', job: { id: 'j1' } } as never);
    captured?.onNotification?.({ ownerId: 'u1', notification: { id: 'n1' } } as never);
    captured?.onQueue?.({ kind: 'dead-letter', at: 'now' } as never);

    expect(jobs).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it('消费者异常相互隔离（一个模块的 bug 不打断其他消费者）', () => {
    const realtime = useRealtimeStore();
    const seen: string[] = [];
    realtime.on('job', () => {
      throw new Error('任务条崩了');
    });
    realtime.on('job', () => seen.push('second'));
    realtime.start();

    expect(() => captured?.onJob?.({ ownerId: 'u1', job: { id: 'j1' } } as never)).not.toThrow();
    expect(seen).toEqual(['second']);
  });

  it('退订后不再收到事件；重复退订幂等', () => {
    const realtime = useRealtimeStore();
    const seen: unknown[] = [];
    const off = realtime.on('notification', (payload) => seen.push(payload));
    expect(realtime.subscriberCount('notification')).toBe(1);
    realtime.start();

    off();
    off();
    expect(realtime.subscriberCount('notification')).toBe(0);
    captured?.onNotification?.({ ownerId: 'u1', notification: { id: 'n1' } } as never);
    expect(seen).toHaveLength(0);
  });

  it('连接状态透出（connecting → open → closed）', () => {
    const realtime = useRealtimeStore();
    realtime.start();
    expect(realtime.status).toBe('connecting');
    captured?.onStatus?.('open');
    expect(realtime.status).toBe('open');
    captured?.onStatus?.('closed');
    expect(realtime.status).toBe('closed');
    realtime.stop();
    expect(realtime.status).toBe('connecting');
  });
});

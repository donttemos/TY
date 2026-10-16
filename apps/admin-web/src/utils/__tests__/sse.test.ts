/*
 * @file SSE 客户端单测（M10 E-12）
 * @description 覆盖统一事件流的浏览器侧语义：能力探测前置（无 EventSource 直接判定不可用，
 *   不白跑一次取票请求）、取票失败降级、建流与事件分发（job / queue）、坏载荷只丢该事件、
 *   断线不信任 EventSource 内建重连（主动关流 + 退避重连）、close 幂等且停止重连。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/utils
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/events', () => ({ fetchSseTicket: vi.fn() }));

import { fetchSseTicket } from '@/api/events';
import { SSE_RECONNECT_BASE_MS, createJobEventStream, type SseStatus } from '../sse';

/** 事件源桩：记录实例与监听器，可手工触发事件 / 错误 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;

  closed = false;

  onerror: (() => void) | null = null;

  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: Event) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(handler);
    this.listeners.set(type, bucket);
  }

  close(): void {
    this.closed = true;
  }

  /** 触发一次命名事件 */
  emit(type: string, payload: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) } as MessageEvent);
    }
  }

  /** 触发连接错误 */
  fail(): void {
    this.onerror?.();
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}

/** 冲刷微任务（取票 → 建流是异步链路） */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.reset();
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

describe('createJobEventStream：能力探测与降级', () => {
  it('环境无 EventSource 时直接判定不可用，不发取票请求', async () => {
    const statuses: SseStatus[] = [];
    const client = createJobEventStream({ onStatus: (status) => statuses.push(status) });
    await flush();
    expect(statuses).toEqual(['closed']);
    expect(fetchSseTicket).not.toHaveBeenCalled();
    client.close();
  });

  it('取票失败（mock / 未登录）时降级为 closed 并按退避重试', async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    vi.mocked(fetchSseTicket).mockRejectedValue(new Error('mock 不提供 SSE'));
    vi.useFakeTimers();

    const statuses: SseStatus[] = [];
    const client = createJobEventStream({ onStatus: (status) => statuses.push(status) });
    await flush();
    expect(statuses).toEqual(['connecting', 'closed']);
    expect(FakeEventSource.instances).toHaveLength(0);

    // 退避到点 → 再取一次票
    await vi.advanceTimersByTimeAsync(SSE_RECONNECT_BASE_MS);
    await flush();
    expect(vi.mocked(fetchSseTicket).mock.calls.length).toBeGreaterThanOrEqual(2);
    client.close();
  });
});

describe('createJobEventStream：建流与事件分发', () => {
  it('取票 → 建流（URL 带票据）→ ready 置 open → job/queue 事件按类型分发', async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    vi.mocked(fetchSseTicket).mockResolvedValue({ ticket: 'tk-1', expiresIn: 60, topics: ['job', 'queue'] });

    const statuses: SseStatus[] = [];
    const jobs: unknown[] = [];
    const alerts: unknown[] = [];
    const client = createJobEventStream({
      onStatus: (status) => statuses.push(status),
      onJob: (payload) => jobs.push(payload),
      onQueue: (payload) => alerts.push(payload),
    });
    await flush();

    expect(statuses).toEqual(['connecting']);
    const source = FakeEventSource.instances[0];
    expect(source?.url).toContain('/events/stream?ticket=tk-1');

    source?.emit('ready', { topics: ['job'] });
    expect(statuses).toEqual(['connecting', 'open']);

    source?.emit('job', { kind: 'progress', job: { id: 'j1', progress: 50 }, ownerId: 'u1' });
    source?.emit('queue', { kind: 'dead-letter', at: 'now', jobId: 'j2' });
    expect(jobs).toHaveLength(1);
    expect(alerts).toHaveLength(1);

    // 坏载荷只丢该事件，不影响后续
    source?.emit('job', '{not json');
    source?.emit('job', { kind: 'finished', job: { id: 'j1', progress: 100 }, ownerId: 'u1' });
    expect(jobs).toHaveLength(2);

    client.close();
  });

  it('连接错误时主动关流并退避重连（不信任内建重连——票据一次性）', async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    vi.mocked(fetchSseTicket).mockResolvedValue({ ticket: 'tk-2', expiresIn: 60, topics: ['job'] });
    vi.useFakeTimers();

    const statuses: SseStatus[] = [];
    const client = createJobEventStream({ onStatus: (status) => statuses.push(status) });
    await flush();
    const first = FakeEventSource.instances[0];
    first?.emit('ready', { topics: ['job'] });
    expect(statuses).toContain('open');

    first?.fail();
    expect(first?.closed).toBe(true);
    expect(statuses[statuses.length - 1]).toBe('closed');

    await vi.advanceTimersByTimeAsync(SSE_RECONNECT_BASE_MS);
    await flush();
    expect(FakeEventSource.instances).toHaveLength(2);
    client.close();
  });

  it('close 幂等：关流后不再重连，也不继续回调状态', async () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    vi.mocked(fetchSseTicket).mockResolvedValue({ ticket: 'tk-3', expiresIn: 60, topics: ['job'] });
    vi.useFakeTimers();

    const statuses: SseStatus[] = [];
    const client = createJobEventStream({ onStatus: (status) => statuses.push(status) });
    await flush();
    const source = FakeEventSource.instances[0];
    source?.emit('ready', { topics: ['job'] });

    client.close();
    client.close();
    expect(source?.closed).toBe(true);

    source?.fail();
    await vi.advanceTimersByTimeAsync(SSE_RECONNECT_BASE_MS * 4);
    await flush();
    expect(FakeEventSource.instances).toHaveLength(1);
    const before = statuses.length;
    await flush();
    expect(statuses).toHaveLength(before);
  });
});

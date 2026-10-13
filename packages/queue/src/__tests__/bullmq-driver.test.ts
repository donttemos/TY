/*
 * @file 单测：bullmq 驱动适配层（结构桩，无真实 Redis）
 * @description 以内存版的结构桩替换 bullmq 模块与 Redis 连接，验证驱动适配层的语义：
 *   入队选项映射（jobId/attempts/delay/priority/backoff 序列/removeOnFail）、消费器装配与 limiter、
 *   PermanentJobError → UnrecoverableError、failed 事件终态判定、统计口径、死信查询/重放/清理、
 *   暂停恢复、取消、优雅停机（含超时强关），以及懒加载与连接的边界报错。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { describe, expect, it, vi } from 'vitest';
import { PermanentJobError, QueueUnavailableError } from '../errors.js';
import { BullmqQueueDriver } from '../drivers/bullmq.driver.js';
import { createBullConnection, loadBullmq, type BullmqModuleLike, type RedisConnectionLike } from '../drivers/bullmq-client.js';
import type { BullJobLike, BullQueueLike, BullWorkerLike } from '../drivers/bullmq-client.js';
import { makeRecord } from './test-helpers.js';

/** 结构桩任务 */
class StubJob implements BullJobLike {
  id?: string;
  attemptsMade = 0;
  failedReason?: string;
  timestamp = Date.now();
  finishedOn?: number;
  state = 'waiting';
  removed = false;
  retried = false;
  opts: { attempts?: number };

  constructor(
    public name: string,
    public data: unknown,
    opts: Record<string, unknown>,
  ) {
    this.opts = { attempts: (opts as { attempts?: number }).attempts };
  }

  async getState(): Promise<string> {
    return this.state;
  }

  async retry(): Promise<void> {
    this.retried = true;
    this.state = 'waiting';
  }

  async remove(): Promise<void> {
    this.removed = true;
  }
}

/** 结构桩队列 */
class StubQueue implements BullQueueLike {
  readonly added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
  readonly jobs = new Map<string, StubJob>();
  failed: StubJob[] = [];
  counts: Record<string, number> = {};
  pausedFlag = false;
  drained: boolean | undefined;
  cleanedTypes: string[] = [];
  closed = false;

  constructor(
    readonly name: string,
    readonly opts: Record<string, unknown>,
  ) {}

  async add(name: string, data: unknown, opts: Record<string, unknown>): Promise<BullJobLike> {
    this.added.push({ name, data, opts });
    const job = new StubJob(name, data, opts);
    job.id = (opts as { jobId?: string }).jobId;
    if (job.id) this.jobs.set(job.id, job);
    return job;
  }

  async getJob(id: string): Promise<BullJobLike | undefined> {
    return this.jobs.get(id);
  }

  async getJobCounts(...types: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const type of types) out[type] = this.counts[type] ?? 0;
    return out;
  }

  async getFailed(start = 0, end = this.failed.length - 1): Promise<BullJobLike[]> {
    return this.failed.slice(start, end + 1);
  }

  async pause(): Promise<void> {
    this.pausedFlag = true;
  }

  async resume(): Promise<void> {
    this.pausedFlag = false;
  }

  async isPaused(): Promise<boolean> {
    return this.pausedFlag;
  }

  async drain(delayed?: boolean): Promise<void> {
    this.drained = delayed ?? false;
  }

  async clean(_grace: number, _limit: number, type?: string): Promise<string[]> {
    this.cleanedTypes.push(type ?? '');
    return ['x', 'y'];
  }

  async retryJobs(): Promise<void> {
    /* noop */
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** 结构桩消费器 */
class StubWorker implements BullWorkerLike {
  readonly handlers = new Map<string, (...args: never[]) => void>();
  readonly closes: boolean[] = [];
  pausedFlag = false;
  resumed = 0;
  /** 为 true 时优雅关闭永不返回（触发停机超时分支） */
  hangClose = false;

  constructor(
    readonly name: string,
    readonly processor: (job: BullJobLike) => Promise<unknown>,
    readonly opts: Record<string, unknown>,
  ) {}

  on(event: string, handler: (...args: never[]) => void): unknown {
    this.handlers.set(event, handler);
    return this;
  }

  async close(force?: boolean): Promise<void> {
    this.closes.push(force ?? false);
    if (this.hangClose && force !== true) return new Promise<void>(() => undefined);
  }

  async pause(): Promise<void> {
    this.pausedFlag = true;
  }

  async resume(): Promise<void> {
    this.pausedFlag = false;
    this.resumed++;
  }

  /** 测试触发：模拟 bullmq 调用处理器 */
  run(job: BullJobLike): Promise<unknown> {
    return this.processor(job);
  }

  /** 测试触发：派发事件 */
  emit(event: string, ...args: never[]): void {
    this.handlers.get(event)?.(...args);
  }
}

class StubUnrecoverableError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

/** 内存版 bullmq 模块 + 实例登记表 */
function makeStubModule(): {
  module: BullmqModuleLike;
  queues: Map<string, StubQueue>;
  workers: Map<string, StubWorker>;
  UnrecoverableError: typeof StubUnrecoverableError;
} {
  const queues = new Map<string, StubQueue>();
  const workers = new Map<string, StubWorker>();
  const module = {
    Queue: class extends StubQueue {
      constructor(name: string, opts: Record<string, unknown>) {
        super(name, opts);
        queues.set(name, this);
      }
    },
    Worker: class extends StubWorker {
      constructor(name: string, processor: (job: BullJobLike) => Promise<unknown>, opts: Record<string, unknown>) {
        super(name, processor, opts);
        workers.set(name, this);
      }
    },
    UnrecoverableError: StubUnrecoverableError,
  } as unknown as BullmqModuleLike;
  return { module, queues, workers, UnrecoverableError: StubUnrecoverableError };
}

/** 结构桩连接 */
function makeConnection(): RedisConnectionLike & { quitCalled: boolean; disconnected: boolean } {
  return {
    quitCalled: false,
    disconnected: false,
    async ping(): Promise<string> {
      return 'PONG';
    },
    async quit(): Promise<unknown> {
      this.quitCalled = true;
      return 'OK';
    },
    disconnect(): void {
      this.disconnected = true;
    },
    on(): unknown {
      return undefined;
    },
  };
}

function makeDriver(): {
  driver: BullmqQueueDriver;
  queues: Map<string, StubQueue>;
  workers: Map<string, StubWorker>;
  connection: ReturnType<typeof makeConnection>;
  runner: { run: ReturnType<typeof vi.fn>; onDeadLetter: ReturnType<typeof vi.fn> };
} {
  const stub = makeStubModule();
  const connection = makeConnection();
  const driver = new BullmqQueueDriver({
    url: 'redis://127.0.0.1:6379/0',
    prefix: 'fw:test',
    concurrency: 2,
    rateLimit: 0,
    deadLetterMax: 50,
    module: stub.module,
    connection,
  });
  const runner = { run: vi.fn(async () => undefined), onDeadLetter: vi.fn() };
  // 真实链路中队列名由 dispatch 预先登记；测试里显式登记以便 start() 装配消费器
  driver.ensureQueue('default');
  return { driver, queues: stub.queues, workers: stub.workers, connection, runner };
}

describe('BullmqQueueDriver：入队与消费器装配', () => {
  it('入队选项完整映射（jobId / attempts / delay / priority / 退避序列 / 保留失败任务）', async () => {
    const { driver, queues, runner } = makeDriver();
    await driver.start(runner);

    const record = makeRecord({ id: 'j1', queue: 'default', name: 'demo', attempts: 4, priority: 5, runAt: Date.now() + 500 });
    await driver.enqueue(record);

    const added = queues.get('default')!.added;
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe('demo');
    expect(added[0].opts).toMatchObject({
      jobId: 'j1',
      attempts: 4,
      priority: 5,
      backoff: { type: 'fw-sequence' },
      removeOnFail: false,
    });
    expect(added[0].opts.delay).toBeGreaterThan(300);
  });

  it('非正优先级不下发 priority；已到期任务 delay 为 0', async () => {
    const { driver, queues, runner } = makeDriver();
    await driver.start(runner);
    await driver.enqueue(makeRecord({ id: 'j2', priority: 0, runAt: Date.now() - 1000 }));
    const opts = queues.get('default')!.added[0].opts;
    expect(opts.priority).toBeUndefined();
    expect(opts.delay).toBe(0);
  });

  it('启动时为已知队列建消费器；rateLimit>0 时下发 limiter 与并发', async () => {
    const stub = makeStubModule();
    const driver = new BullmqQueueDriver({
      url: 'redis://x:6379',
      prefix: 'fw',
      concurrency: 3,
      rateLimit: 20,
      deadLetterMax: 10,
      module: stub.module,
      connection: makeConnection(),
    });
    driver.ensureQueue('orders');
    await driver.start({ run: vi.fn(), onDeadLetter: vi.fn() });
    const worker = stub.workers.get('orders')!;
    expect(worker.opts.concurrency).toBe(3);
    expect(worker.opts.limiter).toEqual({ max: 20, duration: 1000 });
    expect(worker.opts.prefix).toBe('fw');
  });
});

describe('BullmqQueueDriver：执行与死信事件', () => {
  it('处理器转入队记录并交给 runner；PermanentJobError 转 UnrecoverableError', async () => {
    const { driver, workers, runner } = makeDriver();
    await driver.start(runner);
    const worker = workers.get('default')!;
    const record = makeRecord({ id: 'j1', queue: 'default', name: 'demo', attempts: 4 });
    const job = new StubJob('demo', record, { attempts: 4 });
    job.id = 'j1';

    await worker.run(job);
    expect(runner.run).toHaveBeenCalledTimes(1);
    const passed = runner.run.mock.calls[0][0] as { id: string; attemptsMade: number };
    expect(passed.id).toBe('j1');
    expect(passed.attemptsMade).toBe(1);

    runner.run.mockRejectedValueOnce(new PermanentJobError('终态失败'));
    await expect(worker.run(job)).rejects.toBeInstanceOf(StubUnrecoverableError);
  });

  it('failed 事件：达到最大次数才判定死信', async () => {
    const { driver, workers, runner } = makeDriver();
    await driver.start(runner);
    const worker = workers.get('default')!;
    const record = makeRecord({ id: 'j1', name: 'demo', queue: 'default', attempts: 4 });

    const midway = new StubJob('demo', record, { attempts: 4 });
    midway.id = 'j1';
    midway.attemptsMade = 2;
    worker.emit('failed', midway as never, new Error('中间失败') as never);
    expect(runner.onDeadLetter).not.toHaveBeenCalled();

    const exhausted = new StubJob('demo', record, { attempts: 4 });
    exhausted.id = 'j1';
    exhausted.attemptsMade = 4;
    exhausted.failedReason = '炸了';
    worker.emit('failed', exhausted as never, new Error('炸了') as never);
    expect(runner.onDeadLetter).toHaveBeenCalledTimes(1);
    // 第二个参数才是失败原因（第一个参数是任务记录）
    expect(runner.onDeadLetter.mock.calls[0][1]).toBe('炸了');
    expect((runner.onDeadLetter.mock.calls[0][0] as { id: string }).id).toBe('j1');
  });

  it('error 事件被消费（不抛至进程）', async () => {
    const { driver, workers, runner } = makeDriver();
    await driver.start(runner);
    expect(() => workers.get('default')!.emit('error', new Error('连接抖动') as never)).not.toThrow();
  });
});

describe('BullmqQueueDriver：统计与运维', () => {
  it('stats 聚合等待类状态并给出积压', async () => {
    const { driver, queues, runner } = makeDriver();
    await driver.start(runner);
    const queue = queues.get('default')!;
    queue.counts = { waiting: 2, delayed: 1, prioritized: 1, paused: 0, 'waiting-children': 0, active: 1, completed: 5, failed: 3 };

    const stats = await driver.stats();
    expect(stats.driver).toBe('bullmq');
    expect(stats.queues[0]).toMatchObject({ name: 'default', waiting: 4, active: 1, completed: 5, deadLetter: 3, backlog: 5, concurrency: 2 });
    expect(stats.totals).toMatchObject({ waiting: 4, active: 1, completed: 5, deadLetter: 3, backlog: 5 });
    expect(stats.consuming).toBe(true);
  });

  it('死信查询 / 重放 / 清理', async () => {
    const { driver, queues, runner } = makeDriver();
    await driver.start(runner);
    const queue = queues.get('default')!;
    const dead = new StubJob('demo', makeRecord({ id: 'j9', queue: 'default', enqueuedAt: 1_700_000_000_000 }), { attempts: 1 });
    dead.id = 'j9';
    dead.failedReason = '炸了';
    dead.finishedOn = 1_700_000_100_000;
    dead.state = 'failed';
    queue.failed = [dead];
    queue.jobs.set('j9', dead);

    const list = await driver.listDeadLetters();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'j9', name: 'demo', queue: 'default', reason: '炸了' });

    expect(await driver.requeueDeadLetter('j9')).toBe(true);
    expect(dead.retried).toBe(true);
    expect(await driver.requeueDeadLetter('missing')).toBe(false);

    expect(await driver.purgeDeadLetters()).toBe(2);
    expect(queue.cleanedTypes).toEqual(['failed']);
  });

  it('pause / resume 同时作用于队列与消费器', async () => {
    const { driver, queues, workers, runner } = makeDriver();
    await driver.start(runner);
    await driver.pause();
    expect(queues.get('default')!.pausedFlag).toBe(true);
    expect(workers.get('default')!.pausedFlag).toBe(true);
    expect((await driver.stats()).paused).toBe(true);

    await driver.resume();
    expect(queues.get('default')!.pausedFlag).toBe(false);
    expect(workers.get('default')!.resumed).toBe(1);
    expect((await driver.stats()).paused).toBe(false);
  });

  it('drain 按等待类计数返回移除数', async () => {
    const { driver, queues, runner } = makeDriver();
    await driver.start(runner);
    queues.get('default')!.counts = { waiting: 3, delayed: 2, prioritized: 0, paused: 0, 'waiting-children': 0 };
    expect(await driver.drain()).toBe(5);
    expect(queues.get('default')!.drained).toBe(true);
  });

  it('cancel：非活动任务可移除，活动/已完成返回 false', async () => {
    const { driver, queues, runner } = makeDriver();
    await driver.start(runner);
    const queue = queues.get('default')!;
    const job = new StubJob('demo', {}, {});
    job.id = 'j1';
    queue.jobs.set('j1', job);
    expect(await driver.cancel('j1')).toBe(true);
    expect(job.removed).toBe(true);

    job.state = 'active';
    queue.jobs.set('j2', job);
    expect(await driver.cancel('j2')).toBe(false);
    expect(await driver.cancel('missing')).toBe(false);
  });

  it('ping 依赖真实连接探测', async () => {
    const { driver, runner, connection } = makeDriver();
    await driver.start(runner);
    expect(await driver.ping()).toBe(true);
    expect(connection.quitCalled).toBe(false);
  });
});

describe('BullmqQueueDriver：优雅停机', () => {
  it('timeoutMs<=0 直接强制关闭', async () => {
    const { driver, workers, queues, runner, connection } = makeDriver();
    await driver.start(runner);
    const inflight = await driver.close(0);
    expect(inflight).toBe(0);
    expect(workers.get('default')!.closes).toEqual([true]);
    expect(queues.get('default')!.closed).toBe(true);
    expect(connection.quitCalled).toBe(true);
  });

  it('timeoutMs>0 优先优雅关闭', async () => {
    const { driver, workers, runner } = makeDriver();
    await driver.start(runner);
    await driver.close(50);
    expect(workers.get('default')!.closes).toEqual([false]);
  });

  it('优雅关闭超时则强制关闭', async () => {
    const { driver, workers, runner } = makeDriver();
    await driver.start(runner);
    workers.get('default')!.hangClose = true;
    await driver.close(20);
    expect(workers.get('default')!.closes).toEqual([false, true]);
  });
});

describe('bullmq 依赖边界', () => {
  it('loadBullmq 可加载已安装的 bullmq', async () => {
    const mod = await loadBullmq();
    expect(typeof mod.Queue).toBe('function');
    expect(typeof mod.Worker).toBe('function');
    expect(typeof mod.UnrecoverableError).toBe('function');
  });

  it('createBullConnection 缺连接串时报 QueueUnavailableError', async () => {
    await expect(createBullConnection(undefined)).rejects.toBeInstanceOf(QueueUnavailableError);
    await expect(createBullConnection('')).rejects.toBeInstanceOf(QueueUnavailableError);
  });
});

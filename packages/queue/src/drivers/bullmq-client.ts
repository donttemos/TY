/*
 * @file bullmq 依赖的懒加载与连接构造
 * @description 仅在 MQ_DRIVER=bullmq 时经动态 import 加载 bullmq 与 ioredis，
 *   memory 驱动下二者不进入依赖图（PRD-007 FR-02：小系统零 Redis 依赖）。
 *   bullmq / ioredis 均为 **optional peerDependency**，只用 memory 的项目不必安装。
 *   客户端类型以本文件的最小结构接口描述，避免框架层泄漏 bullmq 类型（对齐 ADR-0004 的端口化思路）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { QueueUnavailableError } from '../errors.js';

/** bullmq 任务对象（框架用到的最小子集） */
export interface BullJobLike {
  /** 任务 ID */
  id?: string;
  /** 任务名 */
  name: string;
  /** 任务数据（框架写入的是完整 JobRecord） */
  data: unknown;
  /** 已尝试次数 */
  attemptsMade: number;
  /** 任务选项（attempts / attemptsStarted / delay 等） */
  opts: { attempts?: number };
  /** 失败原因 */
  failedReason?: string;
  /** 入队时刻（毫秒） */
  timestamp: number;
  /** 完成时刻（毫秒） */
  finishedOn?: number;
  /** 当前状态 */
  getState(): Promise<string>;
  /** 重放（failed / completed → wait） */
  retry(state?: string): Promise<void>;
  /** 从队列移除 */
  remove(): Promise<void>;
}

/** bullmq 队列对象（框架用到的最小子集） */
export interface BullQueueLike {
  /** 入队 */
  add(name: string, data: unknown, opts: Record<string, unknown>): Promise<BullJobLike>;
  /** 按 ID 取任务 */
  getJob(id: string): Promise<BullJobLike | undefined>;
  /** 各状态任务数 */
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  /** 失败任务列表 */
  getFailed(start?: number, end?: number): Promise<BullJobLike[]>;
  /** 暂停消费 */
  pause(): Promise<void>;
  /** 恢复消费 */
  resume(): Promise<void>;
  /** 是否暂停 */
  isPaused(): Promise<boolean>;
  /** 清空等待/延时任务 */
  drain(delayed?: boolean): Promise<void>;
  /** 清理指定状态的任务，返回被清理的任务 ID */
  clean(grace: number, limit: number, type?: string): Promise<string[]>;
  /** 批量重放失败任务 */
  retryJobs(opts?: Record<string, unknown>): Promise<void>;
  /** 关闭队列连接 */
  close(): Promise<void>;
}

/** bullmq 消费器对象（框架用到的最小子集） */
export interface BullWorkerLike {
  /** 任务失败事件（含中间重试；attemptsMade >= attempts 即终态） */
  on(event: 'failed', handler: (job: BullJobLike, error: Error) => void): unknown;
  /** 消费器自身异常事件 */
  on(event: 'error', handler: (error: Error) => void): unknown;
  /** 其他事件 */
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  /** 关闭消费（force=true 立即关闭，在途任务交由失速检测恢复） */
  close(force?: boolean): Promise<void>;
  /** 暂停消费 */
  pause(doNotWaitActive?: boolean): Promise<void>;
  /** 恢复消费 */
  resume(): Promise<void>;
}

/** bullmq 模块结构（动态 import 后的最小依赖面） */
export interface BullmqModuleLike {
  /** 队列构造器 */
  Queue: new (name: string, opts: Record<string, unknown>) => BullQueueLike;
  /** 消费器构造器 */
  Worker: new (
    name: string,
    processor: (job: BullJobLike) => Promise<unknown>,
    opts: Record<string, unknown>,
  ) => BullWorkerLike;
  /** 不可恢复错误：抛出后 bullmq 不再重试，直接进 failed（死信） */
  UnrecoverableError: new (message?: string) => Error;
}

/** Redis 客户端最小接口（ioredis 天然满足） */
export interface RedisConnectionLike {
  /** 探测连通性 */
  ping(): Promise<string>;
  /** 优雅关闭 */
  quit(): Promise<unknown>;
  /** 立即断开（quit 失败兜底） */
  disconnect(): void;
  /** 事件订阅（error 必须监听，否则未捕获事件会导致进程退出） */
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

/** ioredis 模块结构 */
interface IoredisModule {
  default: new (urlOrOptions: unknown, options?: Record<string, unknown>) => RedisConnectionLike;
}

/** 懒加载缓存：同一进程只解析一次 */
let bullmqModule: BullmqModuleLike | undefined;

/**
 * 加载 bullmq（缺失时给出可操作提示）
 * @returns bullmq 模块最小结构
 * @throws QueueUnavailableError 未安装 bullmq
 */
export async function loadBullmq(): Promise<BullmqModuleLike> {
  if (bullmqModule) return bullmqModule;
  try {
    bullmqModule = (await import('bullmq')) as unknown as BullmqModuleLike;
    return bullmqModule;
  } catch (cause) {
    throw new QueueUnavailableError(
      '未安装 bullmq：MQ_DRIVER=bullmq 需要 bullmq + ioredis（pnpm add bullmq ioredis）。memory 驱动无需安装。',
      cause,
    );
  }
}

/**
 * 创建 bullmq 连接（ioredis 实例）
 *
 * 注意：`maxRetriesPerRequest` 必须为 `null`——bullmq 在收到实例时会直接抛错校验该值，
 * 且阻塞命令（BRPOPLPUSH）需要无限重试的语义。
 * @param url Redis 连接串
 * @returns ioredis 实例（已挂 error 监听）
 * @throws QueueUnavailableError 缺连接串或未安装 ioredis
 */
export async function createBullConnection(url: string | undefined): Promise<RedisConnectionLike> {
  if (!url) {
    throw new QueueUnavailableError('MQ_DRIVER=bullmq 时必须配置 MQ_URL 或 CACHE_URL（如 redis://127.0.0.1:6379）');
  }
  let mod: IoredisModule;
  try {
    mod = (await import('ioredis')) as unknown as IoredisModule;
  } catch (cause) {
    throw new QueueUnavailableError(`未安装 ioredis：MQ_DRIVER=bullmq 需要 ioredis（pnpm add ioredis）。memory 驱动无需安装。`, cause);
  }
  const client = new mod.default(url, {
    // bullmq 强制要求：阻塞连接不得设置重试上限
    maxRetriesPerRequest: null,
    connectTimeout: 3000,
    enableReadyCheck: true,
  });
  client.on('error', () => {
    // 连接异常由 QueueUnavailableError / 指标反映；此处仅消费事件，避免未捕获异常导致进程退出
  });
  return client;
}

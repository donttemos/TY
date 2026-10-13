/*
 * @file C-08 Job 契约（类型即契约，冻结）
 * @description 并行工作线契约（docs/85-parallel-workstreams.md 表 C-08）：L3 实现、L4 消费。
 *   本文件声明队列与定时调度对外部可观测的**结构与语义**，不含实现：统一 Job 接口、
 *   Job 选项（attempts / backoff / delay / idempotencyKey）、`@JobHandler` 与 `@Cron` 语义、
 *   死信记录、队列统计与指标快照。
 *   实现方（@fw/queue）签名必须与本契约一致；消费方（管理后台队列页 L4、业务 Job 定义）
 *   照此写 API 客户端与类型，无需等待实现。冻结后修改需走契约变更（L0 独占维护）。
 * @author donttemo
 * @created 2026-10-13
 * @module docs/contracts
 */

/** 队列驱动名（由 MQ_DRIVER 决定，消费方不得分支判断） */
export type JobDriverName = 'memory' | 'bullmq' | 'kafka';

/** 队列名：逻辑分组（并发与限速按队列配置），缺省 `default` */
export type QueueName = string;

/** 任务名：`@JobHandler('order.timeout')` 的注册键，全局唯一 */
export type JobName = string;

/** 任务状态机：waiting → active → completed | failed →（重试）… → deadLetter */
export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'deadLetter';

/** 时间量：毫秒数或时长串（`'30s'` / `'30m'` / `'2h'` / `'1d'`），解析规则见 §时长串 */
export type Duration = number | string;

/**
 * 时长串解析规则（冻结）
 * - 支持 `ms|s|m|h|d` 单位，缺单位时按毫秒；
 * - 允许小数（如 `'1.5h'`）；非法格式抛 `JobOptionError`（错误码 1001）。
 * @example '30s' | '5m' | '1.5h' | '2d' | 250
 */
export type DurationInput = Duration;

/** 单次 dispatch 的选项（缺省取 MQ_* 运行时配置） */
export interface JobOptions {
  /** 队列名（默认 `default`），并发/限速按队列生效 */
  queue?: QueueName;
  /** 最大执行次数（含首次）；默认 `MQ_MAX_ATTEMPTS`（4 = 首次 + 3 次重试） */
  attempts?: number;
  /**
   * 重试退避（毫秒序列）：第 n 次重试前等待第 n 项，超出取最后一项。
   * 默认取 `MQ_BACKOFF`（`1000,5000,30000`）。
   */
  backoff?: number[];
  /** 延时执行（`delay` 与 `runAt` 同时给出时以 `runAt` 为准） */
  delay?: Duration;
  /** 指定执行时刻（绝对时间） */
  runAt?: Date;
  /** 幂等键：同一 key 在窗口期内只执行一次（成功后才置位，失败仍可重试） */
  idempotencyKey?: string;
  /** 幂等窗口（秒），默认 3600；当前无对应的 `MQ_*` 环境变量 */
  idempotencyTtlSeconds?: number;
  /** 任务执行超时（秒），默认 `MQ_JOB_TIMEOUT`（60） */
  timeoutSeconds?: number;
  /** 优先级：数字越小越先执行（bullmq 语义，memory 驱动同样生效） */
  priority?: number;
}

/** 入队结果 */
export interface JobHandle {
  /** 任务 ID（驱动侧生成，memory 为 `mem-<n>`，bullmq 为 redis 自增 ID） */
  id: string;
  /** 任务名 */
  name: JobName;
  /** 队列名 */
  queue: QueueName;
  /** 实际执行时刻（`delay` / `runAt` 解析后） */
  runAt: Date;
}

/** 任务执行上下文（处理器第二个参数） */
export interface JobContext<T = unknown> {
  /** 任务 ID */
  jobId: string;
  /** 任务名 */
  name: JobName;
  /** 队列名 */
  queue: QueueName;
  /** 当前第几次执行（从 1 开始） */
  attempt: number;
  /** 最大执行次数 */
  maxAttempts: number;
  /** 原始 payload */
  payload: T;
  /** 链路 traceId（与 HTTP 请求/日志同源，可独立检索） */
  traceId: string;
  /** 结构化日志器（自动带 jobId / traceId） */
  logger: {
    debug(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
}

/**
 * 统一 Job 处理器：`@JobHandler('order.timeout')` 标注在实现类上，
 * 框架在应用启动时按名字注册 `handle`。
 *
 * 语义约定（冻结）：
 * - 抛出的异常一律视为「可重试失败」，由驱动按退避序列重试；
 * - 抛 `PermanentJobError` 视为终态失败，直接进死信、不再重试（TC-JOB-004）；
 * - 处理必须可重入（幂等由 `idempotencyKey` / `@Idempotent` 保证）。
 */
export interface JobHandler<T = unknown> {
  /** 执行体；接收 payload 与上下文 */
  handle(payload: T, ctx: JobContext<T>): Promise<void> | void;
}

/** 死信记录（`failed` 状态耗尽重试后的归档，可查询、可重放、可批量清理） */
export interface DeadLetterRecord {
  /** 任务 ID */
  id: string;
  /** 任务名 */
  name: JobName;
  /** 队列名 */
  queue: QueueName;
  /** 原始 payload（JSON 可序列化） */
  payload: unknown;
  /** 已执行次数 */
  attemptsMade: number;
  /** 失败原因（最后一次异常信息，已截断） */
  reason: string;
  /** 失败时间（ISO 8601） */
  failedAt: string;
  /** 首次入队时间（ISO 8601） */
  enqueuedAt: string;
}

/** 队列统计（`/api/v1/admin/queue/stats` 与 `/metrics` 同源） */
export interface QueueStats {
  /** 驱动名 */
  driver: JobDriverName;
  /** 是否处于暂停状态（暂停后不再消费，等待中的任务保留） */
  paused: boolean;
  /** 队列是否有消费者（暂停或未订阅为 false） */
  consuming: boolean;
  /** 各队列明细 */
  queues: Array<{
    /** 队列名 */
    name: QueueName;
    /** 等待执行（含延时未到期） */
    waiting: number;
    /** 正在执行 */
    active: number;
    /** 已成功 */
    completed: number;
    /** 死信积压 */
    deadLetter: number;
    /** 积压量（waiting + active） */
    backlog: number;
    /** 并发上限 */
    concurrency: number;
    /** 每秒限速（0 = 不限） */
    rateLimit: number;
  }>;
  /** 全局合计（跨队列求和） */
  totals: {
    /** 等待 */
    waiting: number;
    /** 执行中 */
    active: number;
    /** 成功 */
    completed: number;
    /** 死信 */
    deadLetter: number;
    /** 积压 */
    backlog: number;
  };
}

/** 指标快照（`/metrics` 渲染与队列页顶部卡片同源） */
export interface QueueMetricsSnapshot {
  /** 驱动名 */
  driver: JobDriverName;
  /** 入队总数 */
  dispatched: number;
  /** 执行成功次数 */
  succeeded: number;
  /** 执行失败次数（每次重试失败各计一次） */
  failed: number;
  /** 进入死信次数 */
  deadLettered: number;
  /** 因幂等键命中而跳过的次数 */
  idempotentSkipped: number;
  /** 执行超时次数 */
  timedOut: number;
  /** cron 触发次数（含被分布式锁挡下的次数） */
  cronTicked: number;
  /** cron 因未拿到分布式锁而跳过的次数 */
  cronLockedOut: number;
  /** 累计执行耗时（毫秒）与次数，平均耗时 = latencyMs / executed */
  latencyMs: number;
  /** 实际执行次数 */
  executed: number;
}

/**
 * 统一队列接口（框架自有，不暴露 bullmq / Kafka 类型）
 *
 * 语义约定（冻结）：
 * - `dispatch` 立即返回 `JobHandle`，处理在后台进行；memory 驱动下进程退出会丢任务
 *   （PRD-007 §8：memory 仅用于可丢失的轻量任务）；
 * - 驱动切换只改 `MQ_DRIVER`，业务代码 diff = 0（TC-JOB-001）；
 * - 幂等：`idempotencyKey` 命中窗口内已完成记录时直接跳过并计入 `idempotentSkipped`（TC-JOB-006）；
 * - 重放：`requeueDeadLetter` 把死信按原 payload 重新入队，重放成功后该死信记录移除。
 */
export interface QueueServiceContract {
  /** 注册处理器（`@JobHandler` 之外的手动注册入口） */
  register<T>(name: JobName, handler: (payload: T, ctx: JobContext<T>) => Promise<void> | void): void;
  /** 派发任务 */
  dispatch<T>(name: JobName, payload: T, options?: JobOptions): Promise<JobHandle>;
  /** 取消尚未执行的任务；返回是否取消成功 */
  cancel(jobId: string): Promise<boolean>;
  /** 队列统计（积压/在途/成功/死信） */
  stats(): Promise<QueueStats>;
  /** 指标快照 */
  metricsSnapshot(): QueueMetricsSnapshot;
  /** 死信列表（可选按队列过滤） */
  listDeadLetters(queue?: QueueName): Promise<DeadLetterRecord[]>;
  /** 重放单条死信 */
  requeueDeadLetter(id: string): Promise<boolean>;
  /** 清理死信（可选按队列），返回清理数量 */
  purgeDeadLetters(queue?: QueueName): Promise<number>;
  /** 暂停消费（等待中的任务保留） */
  pause(queue?: QueueName): Promise<void>;
  /** 恢复消费 */
  resume(queue?: QueueName): Promise<void>;
  /** 清空等待中的任务，返回清空数量 */
  drain(queue?: QueueName): Promise<number>;
  /** 驱动可用性探测（注册为 `/ready` 探针；memory 恒为 true） */
  ping(): Promise<boolean>;
}

/**
 * `@Cron` 语义（冻结）
 * - 表达式支持 5 段（`m h dom mon dow`）与 6 段（含秒 `s m h dom mon dow`）；
 * - `lock` 默认 **true**：集群内同一触发时刻只在一个实例执行（依赖 C-04 分布式锁）；
 * - `lockTtlSeconds` 缺省取 `max(任务超时, 60)`，开启自动续期，避免长任务被他人抢锁；
 * - 未拿到锁时跳过本次触发并计入 `cronLockedOut`（TC-JOB-002）。
 */
export interface CronOptions {
  /** 任务名（缺省 `<类名>.<方法名>`），也是多实例互斥的锁键 */
  name?: string;
  /** 是否加分布式锁（默认 true；置 false 时多副本会重复执行，仅限单实例部署） */
  lock?: boolean;
  /** 锁 TTL（秒） */
  lockTtlSeconds?: number;
  /** 任务执行超时（秒） */
  timeoutSeconds?: number;
  /** 时区（IANA 名称，如 `Asia/Shanghai`）；缺省取服务器本地时区 */
  timezone?: string;
  /** 是否随应用启动立即执行一次（默认 false） */
  runOnInit?: boolean;
}

/** 队列管理接口路径（免统一响应包装之外，仍需鉴权：`system:queue:list` / `system:queue:manage`） */
export declare const QUEUE_ADMIN_PATHS: {
  /** GET 队列统计 */
  readonly STATS: '/api/v1/admin/queue/stats';
  /** GET 死信列表 */
  readonly DEAD_LETTERS: '/api/v1/admin/queue/dead-letters';
  /** POST 重放死信 `:id` */
  readonly REQUEUE: '/api/v1/admin/queue/dead-letters/:id/requeue';
  /** DELETE 清理死信 */
  readonly PURGE: '/api/v1/admin/queue/dead-letters';
  /** POST 暂停 / 恢复 */
  readonly PAUSE: '/api/v1/admin/queue/pause';
  readonly RESUME: '/api/v1/admin/queue/resume';
  /** DELETE 清空等待队列 */
  readonly DRAIN: '/api/v1/admin/queue/drain';
};

/** 管理页权限码（与 seed 权限点、C-05 权限契约同源） */
export declare const QUEUE_PERMISSIONS: {
  /** 查看队列状态与死信 */
  readonly LIST: 'system:queue:list';
  /** 暂停 / 恢复 / 重放 / 清理 */
  readonly MANAGE: 'system:queue:manage';
};

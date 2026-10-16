/*
 * @file 队列层公共类型
 * @description Job 选项、执行上下文、队列统计与指标快照的形状；
 *   对外契约以 docs/contracts/queue.ts（C-08）为准，本文件不得出现契约外的公共语义改动。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo 新增 DeadLetterWindow（死信窗口查询，分页基础）
 * @module @fw/queue
 */

/** 队列驱动名（MQ_DRIVER）；`kafka` 仅预留端口，M8 落地 */
export type JobDriverName = 'memory' | 'bullmq' | 'kafka';

/** 时间量：毫秒数或时长串（`'30s'` / `'1.5h'` / `'2d'`） */
export type Duration = number | string;

/** 任务状态机 */
export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'deadLetter';

/** 单次 dispatch 的选项（缺省取 MQ_* 运行时配置） */
export interface JobOptions {
  /** 队列名（默认 `default`） */
  queue?: string;
  /** 最大执行次数（含首次） */
  attempts?: number;
  /** 重试退避（毫秒序列） */
  backoff?: number[];
  /** 延时执行 */
  delay?: Duration;
  /** 指定执行时刻（优先于 delay） */
  runAt?: Date;
  /** 幂等键 */
  idempotencyKey?: string;
  /** 幂等窗口（秒） */
  idempotencyTtlSeconds?: number;
  /** 任务执行超时（秒） */
  timeoutSeconds?: number;
  /** 优先级（数字越小越先执行） */
  priority?: number;
}

/** 入队结果 */
export interface JobHandle {
  /** 任务 ID */
  id: string;
  /** 任务名 */
  name: string;
  /** 队列名 */
  queue: string;
  /** 实际执行时刻 */
  runAt: Date;
}

/** 任务运行记录（驱动内部流转的完整快照，也是重放的数据来源） */
export interface JobRecord {
  /** 任务 ID */
  id: string;
  /** 队列名 */
  queue: string;
  /** 任务名 */
  name: string;
  /** 业务载荷（JSON 可序列化） */
  payload: unknown;
  /** 最大执行次数（含首次） */
  attempts: number;
  /** 已执行次数 */
  attemptsMade: number;
  /** 重试退避序列（毫秒） */
  backoff: number[];
  /** 计划执行时刻（epoch 毫秒） */
  runAt: number;
  /** 优先级（数字越小越先） */
  priority: number;
  /** 单次执行超时（毫秒） */
  timeoutMs: number;
  /** 幂等键 */
  idempotencyKey?: string;
  /** 幂等窗口（秒） */
  idempotencyTtlSeconds?: number;
  /** 入队时刻（epoch 毫秒） */
  enqueuedAt: number;
  /**
   * W3C traceparent 头（M8 T-M8-06 链路追踪）：派发时的活跃上下文序列化，消费侧据此
   * 续接同一 traceId（含重试与跨进程消费）。未启用追踪时缺省。
   */
  traceparent?: string;
}

/** 任务执行上下文（处理器第二个参数） */
export interface JobContext<T = unknown> {
  /** 任务 ID */
  jobId: string;
  /** 任务名 */
  name: string;
  /** 队列名 */
  queue: string;
  /** 当前第几次执行（从 1 开始） */
  attempt: number;
  /** 最大执行次数 */
  maxAttempts: number;
  /** 原始 payload */
  payload: T;
  /** 链路 traceId */
  traceId: string;
  /** 结构化日志器（自动带 jobId / traceId） */
  logger: JobLogger;
}

/** 任务内可用的结构化日志器 */
export interface JobLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/** 统一 Job 处理器（PRD-007 FR-01 的 `Job`，契约名为 `JobHandler`） */
export interface Job<T = unknown> {
  /** 执行体；抛异常视为可重试失败，抛 `PermanentJobError` 视为终态失败 */
  handle(payload: T, ctx: JobContext<T>): Promise<void> | void;
}

/** Job 处理器函数形态（`queue.register` 入口） */
export type JobHandlerFn<T = unknown> = (payload: T, ctx: JobContext<T>) => Promise<void> | void;

/** 死信记录 */
export interface DeadLetterRecord {
  /** 任务 ID */
  id: string;
  /** 任务名 */
  name: string;
  /** 队列名 */
  queue: string;
  /** 原始载荷 */
  payload: unknown;
  /** 已执行次数 */
  attemptsMade: number;
  /** 失败原因 */
  reason: string;
  /** 失败时间（ISO 8601） */
  failedAt: string;
  /** 首次入队时间（ISO 8601） */
  enqueuedAt: string;
}

/**
 * 死信窗口（分页读取）
 *
 * 死信集合随失败累积，规模大时全量返回既占内存也拖慢管理页首屏；
 * 驱动按 `offset`/`limit` 只物化所需区间（bullmq 直接映射到 `getFailed(start, end)`）。
 * 不传窗口时保持旧语义（全量），既有调用方零改动。
 */
export interface DeadLetterWindow {
  /** 起始偏移（从 0 开始） */
  offset: number;
  /** 本窗口条数 */
  limit: number;
}

/** 单队列统计明细 */
export interface QueueStatsItem {
  /** 队列名 */
  name: string;
  /** 等待中（含延时未到期） */
  waiting: number;
  /** 执行中 */
  active: number;
  /** 已完成 */
  completed: number;
  /** 死信积压 */
  deadLetter: number;
  /** 积压量（waiting + active） */
  backlog: number;
  /** 并发上限 */
  concurrency: number;
  /** 每秒限速（0 = 不限） */
  rateLimit: number;
}

/** 队列统计（`/api/v1/admin/queue/stats` 与 `/metrics` 同源） */
export interface QueueStats {
  /** 驱动名 */
  driver: JobDriverName;
  /** 是否暂停 */
  paused: boolean;
  /** 是否有消费者在消费 */
  consuming: boolean;
  /** 各队列明细 */
  queues: QueueStatsItem[];
  /** 全局合计 */
  totals: { waiting: number; active: number; completed: number; deadLetter: number; backlog: number };
}

/** 指标快照 */
export interface QueueMetricsSnapshot {
  /** 驱动名 */
  driver: JobDriverName;
  /** 入队总数 */
  dispatched: number;
  /** 成功次数 */
  succeeded: number;
  /** 失败次数（每次重试失败各计一次） */
  failed: number;
  /** 进入死信次数 */
  deadLettered: number;
  /** 幂等跳过次数 */
  idempotentSkipped: number;
  /** 执行超时次数 */
  timedOut: number;
  /** cron 触发次数 */
  cronTicked: number;
  /** cron 未拿到锁跳过次数 */
  cronLockedOut: number;
  /** 累计执行耗时（毫秒） */
  latencyMs: number;
  /** 实际执行次数 */
  executed: number;
}

/** cron 运行时配置 */
export interface CronOptions {
  /** 任务名（缺省 `<类名>.<方法名>`） */
  name?: string;
  /** 是否加分布式锁（默认 true） */
  lock?: boolean;
  /** 锁 TTL（秒） */
  lockTtlSeconds?: number;
  /** 任务执行超时（秒） */
  timeoutSeconds?: number;
  /** 时区（IANA 名称） */
  timezone?: string;
  /** 是否启动后立即执行一次 */
  runOnInit?: boolean;
}

/** cron 条目运行快照（管理页与冒烟断言用） */
export interface CronSnapshot {
  /** 任务名（也是互斥锁键） */
  name: string;
  /** cron 表达式 */
  expression: string;
  /** 是否加锁 */
  lock: boolean;
  /** 下次触发时刻（ISO 8601） */
  nextRunAt: string | null;
  /** 本实例执行次数 */
  runs: number;
  /** 因未拿到分布式锁跳过的次数 */
  lockedOut: number;
  /** 最近一次执行结果 */
  lastResult: 'ok' | 'error' | null;
  /** 最近一次执行时刻（ISO 8601） */
  lastRunAt: string | null;
}

/** 队列运行时配置（由 MQ_* 环境变量构建） */
export interface QueueRuntimeOptions {
  /** 驱动名 */
  driver: JobDriverName;
  /** Redis 连接串（bullmq 必填） */
  url: string | undefined;
  /** 队列名前缀（已解析，不留空） */
  prefix: string;
  /** 每队列并发数 */
  concurrency: number;
  /** 最大执行次数（含首次） */
  maxAttempts: number;
  /** 重试退避序列（毫秒） */
  backoff: number[];
  /** 单任务执行超时（毫秒） */
  jobTimeoutMs: number;
  /** 是否启用 cron */
  cronEnabled: boolean;
  /** 每队列每秒处理上限（0 = 不限） */
  rateLimit: number;
  /** 死信保留上限 */
  deadLetterMax: number;
  /** 死信分页每页条数上限（M10/E-16：管理面 pageSize 钳制上界，原硬编码 200） */
  deadLetterPageSizeMax: number;
  /** 优雅停机等待在途任务的超时（毫秒） */
  shutdownTimeoutMs: number;
  /** bullmq 失速检测间隔（毫秒；0 = 用 bullmq 默认 30s。消费进程被强杀后，在途任务最长等这么久被搬回等待区） */
  stalledIntervalMs: number;
}

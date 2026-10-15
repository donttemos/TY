/*
 * @file 队列驱动端口（QueueDriverPort）
 * @description 框架自有的队列语义抽象：入队、调度（延时/优先级）、重试退避、死信归档、
 *   并发与限速、暂停/恢复/清空、统计与优雅停机。memory 与 bullmq 两种驱动实现同一端口，
 *   QueueService 只依赖本端口，因此切换驱动时业务代码与服务层 diff = 0（PRD-007 AC-001）。
 *   本文件不得出现任何驱动特有类型（bullmq / ioredis 类型）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo 死信查询加窗口：listDeadLetters 增加可选 window（窗口下推到驱动），
 *   新增 countDeadLetters 供分页 total 使用（体验债：死信列表无分页）
 * @modified 2026-10-15 donttemo M9/PRD-009 FR-09：新增可选 applyRuntimeOptions——mq.concurrency /
 *   mq.rateLimit 热更的驱动生效路径（memory 即时生效；bullmq concurrency 即时、rateLimit 重建消费器生效）
 * @modified 2026-10-15 donttemo rateLimit 热更收口：bullmq 重建消费器「先建新再关旧」，消除固化窗口
 * @module @fw/queue
 */

import type { DeadLetterRecord, DeadLetterWindow, JobDriverName, JobRecord, QueueStats } from './types.js';

/**
 * 任务执行回调：驱动把到期任务交给它执行。
 * 约定：抛出异常 = 可重试失败（驱动按退避重排）；抛 `PermanentJobError` = 终态失败（直接进死信）。
 */
export interface JobRunner {
  /**
   * 执行单个任务
   * @param record 任务记录（含 payload 与执行次数）
   */
  run(record: JobRecord): Promise<void>;

  /**
   * 任务被归档为死信时回调（用于计数、告警与日志）
   * @param record 任务记录
   * @param reason 最后一次失败原因
   */
  onDeadLetter(record: JobRecord, reason: string): void;
}

/**
 * 队列驱动端口
 *
 * 语义约定：
 * - `start(runner)` 启动消费；重复调用幂等（已启动则忽略）；
 * - 重试与退避由驱动实现（bullmq 用 `attempts` + 自定义退避策略，memory 用内部定时器），
 *   两者退避序列与「最大执行次数」语义必须一致（TC-JOB-001）；
 * - `close()` 先停止消费，再等待在途任务（超时上限由入参给出）；超时未完成的任务必须
 *   重新入队（memory）或交由驱动的失速恢复机制处理（bullmq），保证「重启不丢任务」。
 */
export interface QueueDriverPort {
  /** 驱动名 */
  readonly kind: JobDriverName;

  /**
   * 启动消费循环
   * @param runner 任务执行回调
   */
  start(runner: JobRunner): Promise<void>;

  /**
   * 入队（含延时与优先级）
   * @param record 任务记录
   */
  enqueue(record: JobRecord): Promise<void>;

  /**
   * 注册队列（并发与限速按队列生效）；未注册时首次入队自动注册
   * @param name 队列名
   */
  ensureQueue(name: string): void;

  /**
   * 取消尚未执行的任务
   * @param jobId 任务 ID
   * @returns 是否取消成功
   */
  cancel(jobId: string): Promise<boolean>;

  /** 暂停消费（等待中的任务保留） */
  pause(queue?: string): Promise<void>;

  /** 恢复消费 */
  resume(queue?: string): Promise<void>;

  /**
   * 清空等待中的任务
   * @param queue 队列名，缺省全部
   * @returns 清空数量
   */
  drain(queue?: string): Promise<number>;

  /**
   * 统计
   * @param queueNames 需要统计的队列（缺省用驱动已知队列）
   */
  stats(queueNames?: readonly string[]): Promise<QueueStats>;

  /**
   * 死信列表
   * @param queue 队列名，缺省全部
   * @param window 分页窗口（缺省全量；规模大时务必传，避免一次性物化整个死信集合）
   */
  listDeadLetters(queue?: string, window?: DeadLetterWindow): Promise<DeadLetterRecord[]>;

  /**
   * 死信条数（分页 total 用；与 listDeadLetters 同一过滤口径）
   * @param queue 队列名，缺省全部
   */
  countDeadLetters(queue?: string): Promise<number>;

  /**
   * 重放单条死信（按原 payload 重新入队）
   * @param id 任务 ID
   * @returns 是否存在并成功重放
   */
  requeueDeadLetter(id: string): Promise<boolean>;

  /**
   * 清理死信
   * @param queue 队列名，缺省全部
   * @returns 清理数量
   */
  purgeDeadLetters(queue?: string): Promise<number>;

  /** 可用性探测 */
  ping(): Promise<boolean>;

  /**
   * 应用运行时选项变更（可选能力，M9/PRD-009 FR-09）：由 QueueService 经配置中心订阅调用。
   * memory 驱动并发与限速即时生效；bullmq 驱动 concurrency 即时生效（Worker 原生可变），
   * rateLimit 随消费器创建固化、变更后记 WARN 待重建生效。未实现该方法的驱动忽略热更。
   * @param patch 待更新字段（并发 / 限速）
   */
  applyRuntimeOptions?(patch: { concurrency?: number; rateLimit?: number }): void;

  /**
   * 优雅停机：停止消费 → 等待在途任务（超时）→ 未完成任务重新入队
   * @param timeoutMs 等待上限（毫秒）
   * @returns 重新入队的在途任务数
   */
  close(timeoutMs?: number): Promise<number>;
}

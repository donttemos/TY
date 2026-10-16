/*
 * @file 队列告警事件汇（M10 E-12）
 * @description `@fw/queue` 的死信告警与积压预警 → SSE 通道的单向出口。与 job-events 同款
 *   模块级汇（先例：`setGlobalRateLimiter`），理由：`QueueModule.forRoot({ alert })` 是**静态**
 *   装配点（拿不到 DI 容器），而发布方（TransportService）必须经 DI 取得。
 *   装配期由 EventsModule 注入真实发布器；未装配时 `publishQueueAlert` 为无害空操作。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/events
 */

/** 队列告警类型：dead-letter（死信）/ backlog（积压超阈） */
export type QueueAlertKind = 'dead-letter' | 'backlog';

/** 队列告警载荷（经 `queue.alert` 主题广播；仅持 `system:queue:list` 的订阅方可见） */
export interface QueueAlertPayload {
  /** 告警类型 */
  kind: QueueAlertKind;
  /** 发生时刻（ISO 字符串） */
  at: string;
  /** 队列名（缺省 = 全部） */
  queue?: string;
  /** 死信：任务 ID */
  jobId?: string;
  /** 死信：任务名 */
  jobName?: string;
  /** 死信：已重试次数 */
  attemptsMade?: number;
  /** 死信：失败原因 */
  reason?: string;
  /** 积压：当前等待任务数 */
  waiting?: number;
  /** 积压：告警阈值 */
  threshold?: number;
}

/** 告警汇签名 */
export type QueueAlertSink = (payload: QueueAlertPayload) => void;

let sink: QueueAlertSink | undefined;

/**
 * 装配告警汇（EventsModule 启动期调用；传 undefined 解除装配）
 * @param next 告警汇，或 undefined
 */
export function setQueueAlertSink(next: QueueAlertSink | undefined): void {
  sink = next;
}

/**
 * 发布一条队列告警（未装配汇时为无害空操作；汇异常不得影响队列本身）
 * @param payload 告警载荷
 */
export function publishQueueAlert(payload: QueueAlertPayload): void {
  if (!sink) return;
  try {
    sink(payload);
  } catch {
    // 事件面故障只影响实时告警，队列运行照常
  }
}

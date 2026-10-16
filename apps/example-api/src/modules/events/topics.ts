/*
 * @file 事件面主题常量（M10 E-12 / E-13）
 * @description `@fw/transport` 事件面的主题命名集中登记：发布方（任务中心、队列、站内信派发器）
 *   与订阅方（SSE 通道、站内信派发器）都从这里取，避免主题字符串散落各处拼写漂移。
 *   独立成文件的原因：通知派发器只依赖主题名，不应为此拉入整个 EventsService（保持模块间
 *   依赖方向清晰）；EventsService 再 re-export 保持既有 import 路径不变。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/events
 */

/** 任务事件主题（载荷 `JobEventPayload`：kind + JobView + ownerId） */
export const JOB_TOPIC = 'job.progress';

/** 队列告警主题（载荷 `QueueAlertPayload`） */
export const QUEUE_TOPIC = 'queue.alert';

/** 站内信新消息主题（载荷 `{ ownerId, notification }`；SSE 据此实时推未读） */
export const NOTIFICATION_TOPIC = 'notification.created';

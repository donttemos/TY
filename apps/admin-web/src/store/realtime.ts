/*
 * @file 实时通道 store（M10 E-12 / E-13）
 * @description **单连接、多消费者**的 SSE 会话：整个页面只建一条 `/events/stream` 长连接，
 *   各业务模块（任务条、消息中心铃铛）按事件类型注册消费者，由本 store 统一分发。
 *
 *   为什么要有这一层：E-12 把流的所有权放在了 `useJobCenter` 里，E-13 再加一个消费者就变成
 *   「两条长连接」——既浪费连接数（服务端 NFR 是单实例 ≥500 连接），也让票据、重连策略出现两份。
 *   抽出本 store 后：连接生命周期只有一处，新增消费者 = 注册一个 handler。
 *
 *   状态语义（`status`）：
 *   - `connecting`：取票 / 建连中；
 *   - `open`：已收到服务端 `ready` 帧（此时可停轮询，改由事件驱动）；
 *   - `closed`：环境不支持 / 取票失败 / 断连（消费者据此降级为轮询兜底）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/store
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { createJobEventStream, type SseClient, type SseStatus } from '@/utils/sse';
import type { JobEventPayload, NotificationCreatedPayload, QueueAlertPayload } from '@/api/types';

/** 可订阅的事件类型（与 SSE `event:` 名一一对应） */
export type RealtimeEvent = 'job' | 'notification' | 'queue';

/** 事件载荷类型映射 */
export interface RealtimePayloadMap {
  job: JobEventPayload;
  notification: NotificationCreatedPayload;
  queue: QueueAlertPayload;
}

export const useRealtimeStore = defineStore('realtime', () => {
  /** 连接状态（初始 connecting：store 建立即表示「打算连」） */
  const status = ref<SseStatus>('connecting');

  /** 事件类型 → 消费者集合 */
  const sinks = new Map<RealtimeEvent, Set<(payload: unknown) => void>>();

  /** 连接句柄（null = 未建） */
  let stream: SseClient | null = null;

  /** 是否已启动（幂等） */
  let started = false;

  /**
   * 注册消费者（返回退订函数，幂等）
   * @param event 事件类型
   * @param handler 处理函数
   */
  function on<T extends RealtimeEvent>(event: T, handler: (payload: RealtimePayloadMap[T]) => void): () => void {
    const bucket = sinks.get(event) ?? new Set();
    const sink = handler as (payload: unknown) => void;
    bucket.add(sink);
    sinks.set(event, bucket);
    return () => {
      const current = sinks.get(event);
      if (!current) return;
      current.delete(sink);
      if (current.size === 0) sinks.delete(event);
    };
  }

  /** 分发（消费者异常隔离，避免一个模块的 bug 打断其他模块） */
  function dispatch(event: RealtimeEvent, payload: unknown): void {
    for (const sink of [...(sinks.get(event) ?? [])]) {
      try {
        sink(payload);
      } catch {
        // 单个消费者异常不影响其他消费者
      }
    }
  }

  /** 建立连接（幂等；已建立则不重复建） */
  function start(): void {
    if (started || typeof window === 'undefined') return;
    started = true;
    stream = createJobEventStream({
      onStatus: (next) => {
        status.value = next;
      },
      onJob: (payload) => dispatch('job', payload),
      onNotification: (payload) => dispatch('notification', payload),
      onQueue: (payload) => dispatch('queue', payload),
    });
  }

  /** 关闭连接（登出；消费者注册保留，下次 start 继续生效） */
  function stop(): void {
    stream?.close();
    stream = null;
    started = false;
    status.value = 'connecting';
  }

  /** 当前消费者数量（诊断与单测断言用） */
  function subscriberCount(event: RealtimeEvent): number {
    return sinks.get(event)?.size ?? 0;
  }

  return { status, on, start, stop, subscriberCount };
});

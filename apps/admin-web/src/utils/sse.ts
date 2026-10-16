/*
 * @file SSE 客户端（M10 E-12）
 * @description 统一事件流的浏览器侧封装：取票 → 建流 → 分发 `job` / `queue` 事件 → 断线自愈。
 *   三个关键取舍：
 *   ① **不用 EventSource 的内建重连**：票据是一次性的，自动重连必然带旧票换回 401，
 *      因此 `onerror` 里主动 close 并由本模块按指数退避重新取票建流（3s → 30s 封顶）；
 *   ② **能力探测前置**：环境无 `EventSource`（Node / jsdom / 老浏览器）或取票失败时，
 *      立刻回调 `closed`，由调用方降级为轮询——不抛异常、不静默卡住；
 *   ③ **载荷解析失败只丢该事件**：单条坏数据不得让整条流退出。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-15 donttemo M10 E-13：新增 `notification` 事件（站内信实时未读）
 * @module admin-web/utils
 */

import { fetchSseTicket } from '@/api/events';
import { API_BASE } from './request';
import type { JobEventPayload, NotificationCreatedPayload, QueueAlertPayload } from '@/api/types';

/** 连接状态：connecting 取票/建连中；open 已收到 ready；closed 不可用（调用方走轮询兜底） */
export type SseStatus = 'connecting' | 'open' | 'closed';

/** 事件处理器 */
export interface SseHandlers {
  /** 任务事件（服务端已按归属人过滤） */
  onJob?: (payload: JobEventPayload) => void;
  /** 站内信（E-13；服务端已按归属人过滤） */
  onNotification?: (payload: NotificationCreatedPayload) => void;
  /** 队列告警（仅持 system:queue:list 的连接会收到） */
  onQueue?: (payload: QueueAlertPayload) => void;
  /** 状态变化 */
  onStatus?: (status: SseStatus) => void;
}

/** 客户端句柄 */
export interface SseClient {
  /** 关闭并停止重连（幂等） */
  close: () => void;
}

/** 重连退避基数与上限（毫秒） */
export const SSE_RECONNECT_BASE_MS = 3000;
export const SSE_RECONNECT_MAX_MS = 30_000;

/**
 * 建一条任务/队列事件流
 * @param handlers 事件与状态回调
 * @returns 客户端句柄
 */
export function createJobEventStream(handlers: SseHandlers): SseClient {
  let source: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: number | null = null;

  const report = (status: SseStatus): void => {
    if (closed) return;
    handlers.onStatus?.(status);
  };

  const scheduleReconnect = (): void => {
    if (closed || retryTimer !== null) return;
    attempt += 1;
    const delay = Math.min(SSE_RECONNECT_MAX_MS, SSE_RECONNECT_BASE_MS * 2 ** (attempt - 1));
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    // 能力探测：无 EventSource（jsdom / 老浏览器）直接判定不可用，交由上层轮询兜底
    if (typeof EventSource === 'undefined') {
      report('closed');
      return;
    }
    report('connecting');

    let ticket: string;
    try {
      const issued = await fetchSseTicket();
      ticket = issued.ticket;
    } catch {
      // 取票失败（未登录 / mock 未实现 / 网络异常）：报告不可用并按退避重试
      report('closed');
      scheduleReconnect();
      return;
    }
    if (closed) return;

    const opened = new EventSource(`${API_BASE}/events/stream?ticket=${encodeURIComponent(ticket)}`);
    source = opened;

    opened.addEventListener('ready', () => {
      attempt = 0;
      report('open');
    });
    opened.addEventListener('job', (event) => {
      const payload = parse<JobEventPayload>(event);
      if (payload) handlers.onJob?.(payload);
    });
    opened.addEventListener('notification', (event) => {
      const payload = parse<NotificationCreatedPayload>(event);
      if (payload) handlers.onNotification?.(payload);
    });
    opened.addEventListener('queue', (event) => {
      const payload = parse<QueueAlertPayload>(event);
      if (payload) handlers.onQueue?.(payload);
    });
    opened.onerror = () => {
      // 票据一次性 → 不信任内建重连；主动关流并自建新一轮
      opened.close();
      if (source === opened) source = null;
      if (closed) return;
      report('closed');
      scheduleReconnect();
    };
  };

  void connect();

  return {
    close(): void {
      closed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      source?.close();
      source = null;
    },
  };
}

/** MessageEvent → 载荷（坏数据返回 null，只丢该事件） */
function parse<T>(event: Event): T | null {
  const data = (event as MessageEvent).data;
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

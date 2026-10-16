/*
 * @file 实时事件 API（M10 E-12）
 * @description SSE 通道的取票端点。EventSource 无法自定义请求头，因此不能直接带 Bearer 令牌——
 *   先经统一请求层（带 Bearer + 401 无感刷新）换取 60s 一次性票据，再用票据建流。
 *   票据在 URL 里只活 60s 且取后即废，泄漏面远小于把 access token 放进查询串。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type { SseTicket } from './types';

/** 取一次性 SSE 票据 */
export function fetchSseTicket(): Promise<SseTicket> {
  return request.post<SseTicket>('/events/ticket');
}

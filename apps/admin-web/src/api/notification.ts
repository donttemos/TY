/*
 * @file 站内信 API（M10 E-13）
 * @description 消息中心用户面：列表（含未读数）、未读数、标记已读、全部已读、删除。
 *   全部端点只操作本人消息（归属人边界在服务端），前端不需要传 userId。
 *   实时新增走 SSE（`notification` 事件），本模块的列表/未读端点既用于首屏，也用于
 *   SSE 不可用时的轮询兜底。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type { NotificationListResult, NotificationView } from './types';

/** 本人消息分页（`unreadOnly` 为真时只回未读） */
export function fetchNotifications(params: { page?: number; pageSize?: number; unreadOnly?: boolean } = {}): Promise<NotificationListResult> {
  return request.get<NotificationListResult>('/notifications', {
    params: {
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 20,
      unreadOnly: params.unreadOnly === true ? 'true' : 'false',
    },
  });
}

/** 未读数（铃铛角标） */
export function fetchUnreadCount(): Promise<number> {
  return request.get<{ unread: number }>('/notifications/unread-count').then((data) => data.unread);
}

/** 标记单条已读（幂等） */
export function markNotificationRead(id: string): Promise<NotificationView> {
  return request.post<NotificationView>(`/notifications/${id}/read`);
}

/** 全部标记已读 */
export function markAllNotificationsRead(): Promise<number> {
  return request.post<{ updated: number }>('/notifications/read-all').then((data) => data.updated);
}

/** 删除本人消息 */
export function removeNotification(id: string): Promise<void> {
  return request.delete<{ id: string; removed: boolean }>(`/notifications/${id}`).then(() => undefined);
}

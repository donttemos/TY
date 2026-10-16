/*
 * @file 站内信 store 单测（M10 E-13）
 * @description 覆盖消息中心数据源语义：首屏加载（列表 + 未读一次性对齐）、实时事件前插并累计未读
 *   （按 id 去重）、标记已读的未读扣减与幂等、全部已读、删除、无 notification:read 时整块降级
 *   （available=false 且不再请求）、换号重置。API 与实时通道均 mock，不打真实网络。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/store
 */

import { setActivePinia, createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/notification', () => ({
  fetchNotifications: vi.fn(),
  fetchUnreadCount: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  removeNotification: vi.fn(),
}));

vi.mock('@/store/realtime', () => ({
  useRealtimeStore: vi.fn(),
}));

import * as notificationApi from '@/api/notification';
import { useRealtimeStore } from '@/store/realtime';
import { useNotificationStore } from '../notification';
import { BizError, BIZ_CODE } from '@/utils/biz-error';
import type { NotificationView } from '@/api/types';

/** 构造消息视图 */
function makeNotification(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id: 'ntf-1',
    kind: 'job.finished',
    level: 'success',
    title: '任务完成：审计日志导出',
    content: '产物 audit.csv 已可下载',
    refType: 'job',
    refId: 'job-1',
    traceId: 'trace-1',
    read: false,
    readAt: null,
    createdAt: '2026-10-15T02:00:00.000Z',
    ...overrides,
  };
}

/** 捕获 realtime 消费者，便于测试内投递事件 */
let emitNotification: ((payload: unknown) => void) | null = null;
const startSpy = vi.fn();
const offSpy = vi.fn();

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  emitNotification = null;
  vi.mocked(useRealtimeStore).mockReturnValue({
    status: 'connecting',
    start: startSpy,
    stop: vi.fn(),
    on: vi.fn((_event: string, handler: (payload: unknown) => void) => {
      emitNotification = handler;
      return offSpy;
    }),
    subscriberCount: () => 1,
  } as never);
  vi.mocked(notificationApi.fetchUnreadCount).mockResolvedValue(0);
});

describe('useNotificationStore：首屏与列表', () => {
  it('restore 注册实时消费者、启动连接并按需拉未读数；重复 restore 同用户不重置', () => {
    const store = useNotificationStore();
    store.restore('u1');
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(notificationApi.fetchUnreadCount).toHaveBeenCalledTimes(1);

    store.unread = 3;
    store.restore('u1');
    expect(store.unread).toBe(3);
  });

  it('load 一次性对齐列表与未读数；append 追加下一页', async () => {
    vi.mocked(notificationApi.fetchNotifications).mockResolvedValue({
      total: 2,
      unread: 1,
      items: [makeNotification()],
      page: 1,
      pageSize: 20,
    });
    const store = useNotificationStore();
    store.restore('u1');
    await store.load({ page: 1 });

    expect(store.total).toBe(2);
    expect(store.unread).toBe(1);
    expect(store.recent).toHaveLength(1);
    expect(store.hasUnread).toBe(true);

    vi.mocked(notificationApi.fetchNotifications).mockResolvedValue({
      total: 2,
      unread: 1,
      items: [makeNotification({ id: 'ntf-2', title: '第二条' })],
      page: 2,
      pageSize: 20,
    });
    await store.load({ page: 2, append: true });
    expect(store.items.map((item) => item.id)).toEqual(['ntf-1', 'ntf-2']);
  });

  it('无 notification:read（3002）时整块降级：available=false 且后续不再请求', async () => {
    vi.mocked(notificationApi.fetchUnreadCount).mockRejectedValue(new BizError(BIZ_CODE.FORBIDDEN, '无操作权限'));
    const store = useNotificationStore();
    store.restore('u1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.available).toBe(false);

    vi.mocked(notificationApi.fetchNotifications).mockClear();
    await store.load({ page: 1 });
    expect(notificationApi.fetchNotifications).not.toHaveBeenCalled();
  });
});

describe('useNotificationStore：实时与动作', () => {
  it('实时事件前插并累计未读；同 id 不重复计数', () => {
    const store = useNotificationStore();
    store.restore('u1');

    emitNotification?.({ ownerId: 'u1', notification: makeNotification() });
    expect(store.items).toHaveLength(1);
    expect(store.unread).toBe(1);
    expect(store.total).toBe(1);

    // 同一 id 重复到达（重连对账/重复投递）：不重复计数
    emitNotification?.({ ownerId: 'u1', notification: makeNotification() });
    expect(store.items).toHaveLength(1);
    expect(store.unread).toBe(1);

    // 已读消息进来只加列表不加未读
    emitNotification?.({ ownerId: 'u1', notification: makeNotification({ id: 'ntf-2', read: true, readAt: '2026-10-15T03:00:00.000Z' }) });
    expect(store.items).toHaveLength(2);
    expect(store.unread).toBe(1);
  });

  it('markRead 扣减未读且幂等；已读项不再请求', async () => {
    vi.mocked(notificationApi.markNotificationRead).mockResolvedValue(makeNotification({ read: true, readAt: '2026-10-15T04:00:00.000Z' }));
    const store = useNotificationStore();
    store.restore('u1');
    emitNotification?.({ ownerId: 'u1', notification: makeNotification() });

    await store.markRead('ntf-1');
    expect(store.unread).toBe(0);
    expect(store.items[0]?.read).toBe(true);

    await store.markRead('ntf-1');
    expect(notificationApi.markNotificationRead).toHaveBeenCalledTimes(1);
  });

  it('markAllRead 清零未读；remove 删除并回落计数', async () => {
    vi.mocked(notificationApi.markAllNotificationsRead).mockResolvedValue(2);
    vi.mocked(notificationApi.removeNotification).mockResolvedValue(undefined);
    const store = useNotificationStore();
    store.restore('u1');
    emitNotification?.({ ownerId: 'u1', notification: makeNotification({ id: 'a' }) });
    emitNotification?.({ ownerId: 'u1', notification: makeNotification({ id: 'b' }) });

    expect(await store.markAllRead()).toBe(2);
    expect(store.unread).toBe(0);
    expect(store.items.every((item) => item.read)).toBe(true);

    await store.remove('b');
    expect(store.items.map((item) => item.id)).toEqual(['a']);
    expect(store.total).toBe(1);
  });

  it('删除未读消息同时扣减未读；reset 注销消费者并清空', async () => {
    vi.mocked(notificationApi.removeNotification).mockResolvedValue(undefined);
    const store = useNotificationStore();
    store.restore('u1');
    emitNotification?.({ ownerId: 'u1', notification: makeNotification({ id: 'a' }) });
    expect(store.unread).toBe(1);

    await store.remove('a');
    expect(store.unread).toBe(0);
    expect(store.total).toBe(0);

    store.reset();
    expect(offSpy).toHaveBeenCalledTimes(1);
    expect(store.items).toHaveLength(0);
    expect(store.unread).toBe(0);
  });
});

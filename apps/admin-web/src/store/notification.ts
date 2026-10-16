/*
 * @file 站内信 store（M10 E-13）
 * @description 消息中心的单例数据源：列表 + 未读数 + 已读/删除动作，并对接 `store/realtime`
 *   的 `notification` 事件做**实时未读**（无需轮询）。
 *
 *   与任务条 store 的关系：两者共用同一条 SSE 连接（`store/realtime`），各自注册自己的消费者——
 *   任务条关心 job / queue，消息中心关心 notification。
 *
 *   降级路径：实时事件不可用时，未读数会在「打开铃铛 / 切换到消息中心」时按需拉取
 *   （`refreshUnread`），不引入定时轮询——消息中心不是秒级战场，按需刷新足够，
 *   而任务进度需要秒级（那由任务条 store 的轮询兜底覆盖）。
 *
 *   权限：无 `notification:read` 时接口返回 3002，本 store 记 `available=false`，
 *   顶栏铃铛据此整块隐藏（而不是显示一个点了报错的图标）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/store
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as notificationApi from '@/api/notification';
import { BizError, BIZ_CODE } from '@/utils/biz-error';
import { useRealtimeStore } from './realtime';
import type { NotificationCreatedPayload, NotificationView } from '@/api/types';

/** 铃铛下拉最多展示的条数（更多历史进消息中心页/分页加载） */
export const BELL_PREVIEW_SIZE = 8;

export const useNotificationStore = defineStore('notification', () => {
  /** 已加载的消息（新在前） */
  const items = ref<NotificationView[]>([]);
  /** 过滤条件下的总数 */
  const total = ref(0);
  /** 未读数（铃铛角标） */
  const unread = ref(0);
  /** 当前页码（下拉「加载更多」用） */
  const page = ref(1);
  /** 是否正在加载 */
  const loading = ref(false);
  /** 当前账号是否可用消息中心（无 notification:read 时为 false） */
  const available = ref(true);

  const realtime = useRealtimeStore();

  /** 消费者退订句柄 */
  let offRealtime: (() => void) | null = null;
  /** 归属人（换号隔离） */
  let ownerId: string | null = null;

  /** 是否有未读 */
  const hasUnread = computed(() => unread.value > 0);

  /** 铃铛下拉展示的最近若干条 */
  const recent = computed(() => items.value.slice(0, BELL_PREVIEW_SIZE));

  /** 合并一条消息（按 id 去重；新消息前插并累计未读） */
  function upsert(view: NotificationView, isNew = false): void {
    const index = items.value.findIndex((item) => item.id === view.id);
    if (index >= 0) {
      items.value[index] = view;
      return;
    }
    items.value.unshift(view);
    if (isNew) {
      total.value += 1;
      if (!view.read) unread.value += 1;
    }
  }

  /** 实时事件：服务端已按归属人过滤，直接采纳 */
  function applyRealtime(payload: NotificationCreatedPayload): void {
    if (!payload?.notification?.id) return;
    upsert(payload.notification, true);
  }

  /** 拉取未读数（铃铛打开 / 实时不可用时的按需刷新） */
  async function refreshUnread(): Promise<void> {
    if (!available.value) return;
    try {
      unread.value = await notificationApi.fetchUnreadCount();
    } catch (error) {
      if (error instanceof BizError && error.code === BIZ_CODE.FORBIDDEN) available.value = false;
    }
  }

  /**
   * 拉取列表（默认第一页；`append` 为真时追加下一页）
   * @param options 分页与追加选项
   */
  async function load(options: { page?: number; pageSize?: number; unreadOnly?: boolean; append?: boolean } = {}): Promise<void> {
    if (!available.value || loading.value) return;
    const targetPage = options.page ?? 1;
    loading.value = true;
    try {
      const result = await notificationApi.fetchNotifications({
        page: targetPage,
        pageSize: options.pageSize ?? 20,
        unreadOnly: options.unreadOnly,
      });
      items.value = options.append ? [...items.value, ...result.items] : result.items;
      total.value = result.total;
      unread.value = result.unread;
      page.value = result.page;
    } catch (error) {
      if (error instanceof BizError && error.code === BIZ_CODE.FORBIDDEN) available.value = false;
      else throw error;
    } finally {
      loading.value = false;
    }
  }

  /** 标记单条已读（幂等） */
  async function markRead(id: string): Promise<void> {
    const target = items.value.find((item) => item.id === id);
    if (target?.read) return;
    const view = await notificationApi.markNotificationRead(id);
    upsert(view);
    if (unread.value > 0) unread.value -= 1;
  }

  /** 全部标记已读 */
  async function markAllRead(): Promise<number> {
    const updated = await notificationApi.markAllNotificationsRead();
    items.value = items.value.map((item) => (item.read ? item : { ...item, read: true, readAt: new Date().toISOString() }));
    unread.value = 0;
    return updated;
  }

  /** 删除本人消息 */
  async function remove(id: string): Promise<void> {
    const target = items.value.find((item) => item.id === id);
    await notificationApi.removeNotification(id);
    items.value = items.value.filter((item) => item.id !== id);
    if (total.value > 0) total.value -= 1;
    if (target && !target.read && unread.value > 0) unread.value -= 1;
  }

  /**
   * 初始化（顶栏挂载时调用）：注册实时消费者 + 首屏加载
   * @param currentUserId 当前登录用户（换号时重置）
   */
  function restore(currentUserId: string): void {
    if (ownerId === currentUserId) return;
    ownerId = currentUserId;
    available.value = true;
    items.value = [];
    total.value = 0;
    unread.value = 0;
    if (!offRealtime) offRealtime = realtime.on('notification', applyRealtime);
    realtime.start();
    void refreshUnread();
  }

  /** 重置（登出）：注销消费者并清空 */
  function reset(): void {
    offRealtime?.();
    offRealtime = null;
    ownerId = null;
    items.value = [];
    total.value = 0;
    unread.value = 0;
    page.value = 1;
    available.value = true;
  }

  return {
    items,
    total,
    unread,
    page,
    loading,
    available,
    hasUnread,
    recent,
    refreshUnread,
    load,
    markRead,
    markAllRead,
    remove,
    restore,
    reset,
    applyRealtime,
  };
});

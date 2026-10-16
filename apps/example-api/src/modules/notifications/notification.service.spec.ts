/*
 * @file 单测：站内信服务（M10 E-13）
 * @description 覆盖服务语义：写入幂等（dedupeKey 命中不重复建）、分页与未读过滤、pageSize 钳制、
 *   未读计数、标记已读（幂等 + 越权 404）、全部已读、删除（越权 404）、保留窗口裁剪、
 *   广播写入的幂等键后缀、对外视图不泄露内部字段。用内存存储，不依赖数据库。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/notifications
 */

import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_MAX_PER_USER, MemoryNotificationStore } from './notification.store.js';
import { NotificationService, toView } from './notification.service.js';

/** 构造服务 + 内存存储 */
function makeService(): { service: NotificationService; store: MemoryNotificationStore } {
  const store = new MemoryNotificationStore();
  return { service: new NotificationService(store), store };
}

/** 写入一条基础通知 */
async function seed(service: NotificationService, overrides: Record<string, unknown> = {}): Promise<ReturnType<NotificationService['create']>> {
  return service.create({
    userId: 'u1',
    kind: 'job.finished',
    level: 'success',
    title: '任务完成：导出',
    content: null,
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  });
}

describe('NotificationService：写入与幂等', () => {
  it('写入成功返回行；同一 dedupeKey 重复写入被拒（返回 null，不抛错）', async () => {
    const { service } = makeService();
    const first = await seed(service, { dedupeKey: 'job:j1:succeeded:t1' });
    expect(first?.id.startsWith('ntf-')).toBe(true);
    const second = await seed(service, { dedupeKey: 'job:j1:succeeded:t1' });
    expect(second).toBeNull();
    expect((await service.list('u1', { page: 1, pageSize: 20 })).total).toBe(1);
  });

  it('广播写入：幂等键自动追加收件人后缀，重复广播不重复建', async () => {
    const { service } = makeService();
    const base = { kind: 'queue.backlog' as const, level: 'warning' as const, title: '队列积压告警', dedupeKey: 'queue:backlog:at1' };
    const first = await service.broadcast(base, ['u1', 'u2']);
    expect(first).toHaveLength(2);
    const second = await service.broadcast(base, ['u1', 'u2', 'u1']);
    expect(second).toHaveLength(0);
    expect((await service.list('u1', { page: 1, pageSize: 20 })).total).toBe(1);
    expect((await service.list('u2', { page: 1, pageSize: 20 })).total).toBe(1);
  });

  it('保留窗口：超过上限淘汰最旧，未读计数不会无界增长', async () => {
    const { service } = makeService();
    // 用假时钟推进 createdAt（真实 setTimeout 逐条推进要 200+ 次，慢且不稳）
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'));
      for (let i = 0; i < NOTIFICATION_MAX_PER_USER + 3; i += 1) {
        await seed(service, { dedupeKey: `k${String(i).padStart(4, '0')}`, title: `第 ${i} 条` });
        vi.setSystemTime(new Date(Date.now() + 1000));
      }
      const listed = await service.list('u1', { page: 1, pageSize: 200 });
      expect(listed.total).toBe(NOTIFICATION_MAX_PER_USER);
      // 最旧的几条被淘汰，最新一条一定在
      expect(listed.items[0]?.title).toBe(`第 ${NOTIFICATION_MAX_PER_USER + 2} 条`);
      expect(listed.items.some((item) => item.title === '第 0 条')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('NotificationService：查询与已读', () => {
  it('分页：倒序返回、unreadOnly 过滤、pageSize 越界收敛到上限', async () => {
    const { service } = makeService();
    await seed(service, { dedupeKey: 'a', title: '第一条' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await seed(service, { dedupeKey: 'b', title: '第二条' });

    const all = await service.list('u1', { page: 1, pageSize: 20 });
    expect(all.items.map((item) => item.title)).toEqual(['第二条', '第一条']);
    expect(all.unread).toBe(2);

    const first = await service.list('u1', { page: 1, pageSize: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(2);

    const oversized = await service.list('u1', { page: 1, pageSize: 9999 });
    expect(oversized.pageSize).toBe(200);

    const target = all.items[1] as { id: string };
    await service.markRead(target.id, 'u1');
    const unreadOnly = await service.list('u1', { page: 1, pageSize: 20, unreadOnly: true });
    expect(unreadOnly.items.map((item) => item.title)).toEqual(['第二条']);
  });

  it('标记已读幂等；越权 / 不存在一律 404', async () => {
    const { service } = makeService();
    const row = await seed(service, { dedupeKey: 'a' });
    const id = (row as { id: string }).id;

    const first = await service.markRead(id, 'u1');
    expect(first.read).toBe(true);
    const second = await service.markRead(id, 'u1');
    expect(second.read).toBe(true);

    await expect(service.markRead(id, 'other')).rejects.toThrow(/消息不存在/);
    await expect(service.markRead('missing', 'u1')).rejects.toThrow(/消息不存在/);
    await expect(service.remove(id, 'other')).rejects.toThrow(/消息不存在/);
  });

  it('全部已读只影响本人', async () => {
    const { service } = makeService();
    await seed(service, { dedupeKey: 'a', userId: 'u1' });
    await seed(service, { dedupeKey: 'b', userId: 'u1' });
    await seed(service, { dedupeKey: 'c', userId: 'u2' });

    expect(await service.markAllRead('u1')).toBe(2);
    expect(await service.markAllRead('u1')).toBe(0);
    expect(await service.unreadCount('u1')).toBe(0);
    expect(await service.unreadCount('u2')).toBe(1);
  });

  it('删除本人消息后计数回落；对外视图不含 userId / dedupeKey', async () => {
    const { service } = makeService();
    const row = await seed(service, { dedupeKey: 'a' });
    const view = toView(row as never);
    expect(Object.keys(view)).not.toContain('userId');
    expect(Object.keys(view)).not.toContain('dedupeKey');
    expect(view.read).toBe(false);

    await service.remove(view.id, 'u1');
    expect((await service.list('u1', { page: 1, pageSize: 20 })).total).toBe(0);
    await expect(service.remove(view.id, 'u1')).rejects.toThrow(/消息不存在/);
  });

  it('收件人解析委托存储层（队列告警广播用）', async () => {
    const { service, store } = makeService();
    store.permissionRecipients.set('system:queue:list', ['u1', 'u1', 'u2']);
    expect(await service.recipientsByPermission('system:queue:list')).toEqual(['u1', 'u2']);
    expect(await service.recipientsByPermission('nobody')).toEqual([]);
  });
});

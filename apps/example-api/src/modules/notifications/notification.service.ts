/*
 * @file 站内信服务（M10 E-13）
 * @description 通知中心的业务语义：写入（幂等）、本人列表 / 未读数、标记已读、删除、保留窗口裁剪。
 *   服务的边界约定：
 *   - **归属人即权限边界**：读 / 标已读 / 删除一律按 `userId` 收敛，越权返回 404（不泄露存在性，
 *     与 `/jobs/:id/*` 同语义）；
 *   - **写入幂等**：`dedupeKey` 唯一（存储层唯一约束兜底），重复投递不产生重复消息；
 *   - **无界增长有界化**：写入后按 `NOTIFICATION_MAX_PER_USER` 裁剪，未读计数不会随历史线性变慢；
 *   - **对外视图不含内部字段**（userId / tenantId / dedupeKey 不外泄）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/notifications
 */

import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BizError, ErrorCode } from '@fw/core';
import {
  NOTIFICATION_MAX_PER_USER,
  type NotificationKind,
  type NotificationLevel,
  type NotificationRow,
  type NotificationStore,
} from './notification.store.js';
import { NOTIFICATION_STORE } from './notification.tokens.js';

/** 列表每页上限（与 api-spec §1.5 列表约定一致；越界收敛而非报错） */
export const NOTIFICATION_PAGE_MAX = 200;

/** 对外通知视图（`GET /notifications` 列表项） */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  content: string | null;
  refType: string | null;
  refId: string | null;
  traceId: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

/** 写入入参 */
export interface CreateNotificationInput {
  /** 收件人 */
  userId: string;
  /** 租户（缺省 0 = 默认租户，与既有表同约定） */
  tenantId?: number;
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  content?: string | null;
  refType?: string | null;
  refId?: string | null;
  traceId?: string | null;
  /** 幂等键（唯一；广播写入会自动追加收件人后缀） */
  dedupeKey: string;
}

/** 列表查询入参 */
export interface NotificationListQuery {
  page: number;
  pageSize: number;
  unreadOnly?: boolean;
}

/**
 * 站内信服务
 */
@Injectable()
export class NotificationService {
  /**
   * @param store 持久层（Prisma / 内存）
   */
  constructor(@Inject(NOTIFICATION_STORE) private readonly store: NotificationStore) {}

  /**
   * 写入一条通知（幂等）
   * @param input 写入入参
   * @returns 实际写入的行；重复投递（dedupeKey 命中）返回 null
   */
  async create(input: CreateNotificationInput): Promise<NotificationRow | null> {
    const now = new Date().toISOString();
    const row: NotificationRow = {
      id: `ntf-${randomUUID()}`,
      tenantId: input.tenantId ?? 0,
      userId: input.userId,
      kind: input.kind,
      level: input.level,
      title: input.title,
      content: input.content ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      traceId: input.traceId ?? null,
      dedupeKey: input.dedupeKey,
      readAt: null,
      createdAt: now,
    };
    const inserted = await this.store.insert(row);
    if (!inserted) return null;
    await this.store.prune(row.userId, NOTIFICATION_MAX_PER_USER);
    return row;
  }

  /**
   * 广播写入：同一事件对多个收件人各写一条（幂等键追加收件人后缀）
   * @param base 除 userId 外的写入入参
   * @param userIds 收件人列表
   * @returns 写入条数
   */
  async broadcast(base: Omit<CreateNotificationInput, 'userId'>, userIds: readonly string[]): Promise<NotificationRow[]> {
    const created: NotificationRow[] = [];
    for (const userId of [...new Set(userIds)]) {
      const row = await this.create({ ...base, userId, dedupeKey: `${base.dedupeKey}:${userId}` });
      if (row) created.push(row);
    }
    return created;
  }

  /**
   * 本人通知分页
   * @param userId 当前用户
   * @param query 分页与未读过滤
   */
  async list(userId: string, query: NotificationListQuery): Promise<{ total: number; unread: number; items: NotificationView[]; page: number; pageSize: number }> {
    const page = Number.isFinite(query.page) ? Math.max(1, Math.floor(query.page)) : 1;
    const pageSize = Number.isFinite(query.pageSize) ? Math.min(NOTIFICATION_PAGE_MAX, Math.max(1, Math.floor(query.pageSize))) : 20;
    const [{ total, items }, unread] = await Promise.all([
      this.store.page({ userId, unreadOnly: query.unreadOnly === true, page, pageSize }),
      this.store.countUnread(userId),
    ]);
    return { total, unread, items: items.map(toView), page, pageSize };
  }

  /**
   * 未读数（铃铛用）
   * @param userId 当前用户
   */
  async unreadCount(userId: string): Promise<number> {
    return this.store.countUnread(userId);
  }

  /**
   * 标记已读（幂等：已读再标仍返回成功）
   * @param id 通知 ID
   * @param userId 当前用户
   * @returns 变更后的视图
   */
  async markRead(id: string, userId: string): Promise<NotificationView> {
    const row = await this.store.findById(id);
    if (!row || row.userId !== userId) throw new BizError(ErrorCode.NOT_FOUND, '消息不存在');
    if (row.readAt === null) {
      const readAt = new Date().toISOString();
      await this.store.markRead(id, userId, readAt);
      row.readAt = readAt;
    }
    return toView(row);
  }

  /**
   * 全部标记已读
   * @param userId 当前用户
   * @returns 更新条数
   */
  async markAllRead(userId: string): Promise<number> {
    return this.store.markAllRead(userId, new Date().toISOString());
  }

  /**
   * 删除本人通知
   * @param id 通知 ID
   * @param userId 当前用户
   */
  async remove(id: string, userId: string): Promise<void> {
    const row = await this.store.findById(id);
    if (!row || row.userId !== userId) throw new BizError(ErrorCode.NOT_FOUND, '消息不存在');
    await this.store.remove(id, userId);
  }

  /**
   * 按权限码解析收件人（队列告警广播用）
   * @param code 权限码
   */
  async recipientsByPermission(code: string): Promise<string[]> {
    return this.store.listUserIdsByPermission(code);
  }
}

/** 行 → 对外视图（剥掉 userId / tenantId / dedupeKey） */
export function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    level: row.level,
    title: row.title,
    content: row.content,
    refType: row.refType,
    refId: row.refId,
    traceId: row.traceId,
    read: row.readAt !== null,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

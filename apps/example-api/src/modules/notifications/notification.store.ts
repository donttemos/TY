/*
 * @file 站内信持久层（M10 E-13）
 * @description `NotificationStore` 端口 + 内存实现（单测）+ Prisma 实现（生产，`notifications` 表，
 *   数据字典 §3.18）。沿用本仓「本地投影 + delegate」约定（不直接依赖 @prisma/client 生成类型），
 *   与 PrismaJobStore / PrismaTenantStore 同形。
 *
 *   三个关键语义：
 *   ① **幂等靠唯一约束**：`dedupe_key` 唯一，重复投递（多副本各一条订阅、任务重试后再次终态）
 *      在并发插入时只有一个成功，其余按 `false` 返回——不用「先查后写」（那有竞态窗口）；
 *   ② **归属人收敛在存储层**：读 / 标已读 / 删除一律带 `user_id`，越权在 SQL 层就没有命中行；
 *   ③ **保留窗口**：每人最多保留 N 条（默认 200），超出淘汰最旧——消息是「提醒」不是「档案」，
 *      无界增长会拖慢未读计数。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/notifications
 */

import { Inject, Injectable } from '@nestjs/common';
import { DB_CLIENT, type PrismaClientLike } from '@fw/db';

/** 单人保留条数上限（超出淘汰最旧） */
export const NOTIFICATION_MAX_PER_USER = 200;

/** 通知级别（前端按级别着色：info 蓝 / success 绿 / warning 橙 / error 红） */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/** 通知业务类型（与事件源的映射关系见 notification-dispatcher.ts） */
export type NotificationKind = 'job.finished' | 'job.failed' | 'queue.dead-letter' | 'queue.backlog' | 'system';

/** 持久层行（与 notifications 表列一一对应；时间统一 ISO 字符串） */
export interface NotificationRow {
  id: string;
  tenantId: number;
  userId: string;
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  content: string | null;
  /** 关联资源类型（job / queue / null） */
  refType: string | null;
  /** 关联资源 ID（如 jobId） */
  refId: string | null;
  traceId: string | null;
  /** 幂等键（唯一） */
  dedupeKey: string;
  /** 已读时刻（未读为 null） */
  readAt: string | null;
  createdAt: string;
}

/** 分页查询入参 */
export interface NotificationQuery {
  userId: string;
  /** 仅未读 */
  unreadOnly: boolean;
  page: number;
  pageSize: number;
}

/** 站内信存储端口 */
export interface NotificationStore {
  /**
   * 新增（幂等）：`dedupeKey` 冲突返回 false（重复投递），成功返回 true
   */
  insert(row: NotificationRow): Promise<boolean>;

  /** 按主键读行（不校验归属，归属校验在服务层做） */
  findById(id: string): Promise<NotificationRow | null>;

  /** 分页查询（本人；按 createdAt 倒序，同一时刻按 id 倒序保证稳定） */
  page(query: NotificationQuery): Promise<{ total: number; items: NotificationRow[] }>;

  /** 未读数（本人） */
  countUnread(userId: string): Promise<number>;

  /** 标记已读（仅未读行会被更新），返回实际更新条数 */
  markRead(id: string, userId: string, readAt: string): Promise<number>;

  /** 全部标记已读（本人），返回更新条数 */
  markAllRead(userId: string, readAt: string): Promise<number>;

  /** 删除单条（本人归属），返回是否删除 */
  remove(id: string, userId: string): Promise<boolean>;

  /** 保留窗口裁剪：每人只留最新 maxEntries 条，返回删除条数 */
  prune(userId: string, maxEntries: number): Promise<number>;

  /**
   * 按权限码解析收件人（队列告警的收件人来源：持 `system:queue:list` 的启用账号）
   * @param code 权限码
   * @returns 用户 ID 列表（去重）
   */
  listUserIdsByPermission(code: string): Promise<string[]>;
}

/**
 * 内存实现：单测与无 DB 场景（语义与 Prisma 版逐字一致，双实现对撞由单测保证）
 */
export class MemoryNotificationStore implements NotificationStore {
  private readonly rows = new Map<string, NotificationRow>();

  /** 权限码 → 用户 ID（单测注入收件人用） */
  readonly permissionRecipients = new Map<string, string[]>();

  async insert(row: NotificationRow): Promise<boolean> {
    for (const existing of this.rows.values()) {
      if (existing.dedupeKey === row.dedupeKey) return false;
    }
    this.rows.set(row.id, { ...row });
    return true;
  }

  async findById(id: string): Promise<NotificationRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async page(query: NotificationQuery): Promise<{ total: number; items: NotificationRow[] }> {
    const all = [...this.rows.values()]
      .filter((row) => row.userId === query.userId && (!query.unreadOnly || row.readAt === null))
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    const offset = (query.page - 1) * query.pageSize;
    return { total: all.length, items: all.slice(offset, offset + query.pageSize).map((row) => ({ ...row })) };
  }

  async countUnread(userId: string): Promise<number> {
    return [...this.rows.values()].filter((row) => row.userId === userId && row.readAt === null).length;
  }

  async markRead(id: string, userId: string, readAt: string): Promise<number> {
    const row = this.rows.get(id);
    if (!row || row.userId !== userId || row.readAt !== null) return 0;
    row.readAt = readAt;
    return 1;
  }

  async markAllRead(userId: string, readAt: string): Promise<number> {
    let updated = 0;
    for (const row of this.rows.values()) {
      if (row.userId === userId && row.readAt === null) {
        row.readAt = readAt;
        updated += 1;
      }
    }
    return updated;
  }

  async remove(id: string, userId: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.userId !== userId) return false;
    return this.rows.delete(id);
  }

  async prune(userId: string, maxEntries: number): Promise<number> {
    const mine = [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
    let removed = 0;
    while (mine.length - removed > maxEntries) {
      this.rows.delete((mine[removed] as NotificationRow).id);
      removed += 1;
    }
    return removed;
  }

  async listUserIdsByPermission(code: string): Promise<string[]> {
    return [...new Set(this.permissionRecipients.get(code) ?? [])];
  }
}

/** Prisma notifications 表行投影 */
interface NotificationPrismaRow {
  id: string;
  tenantId: bigint | number;
  userId: string;
  kind: string;
  level: string;
  title: string;
  content: string | null;
  refType: string | null;
  refId: string | null;
  traceId: string | null;
  dedupeKey: string;
  readAt: Date | null;
  createdAt: Date;
}

/** 行 → 记录投影 */
function toRecord(row: NotificationPrismaRow): NotificationRow {
  return {
    id: row.id,
    tenantId: Number(row.tenantId ?? 0),
    userId: row.userId,
    kind: row.kind as NotificationKind,
    level: (['info', 'success', 'warning', 'error'].includes(row.level) ? row.level : 'info') as NotificationLevel,
    title: row.title,
    content: row.content,
    refType: row.refType,
    refId: row.refId,
    traceId: row.traceId,
    dedupeKey: row.dedupeKey,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** delegate 形状（本地投影，避免依赖生成类型） */
interface NotificationDelegate {
  create(args: { data: Record<string, unknown> }): Promise<NotificationPrismaRow>;
  findUnique(args: { where: { id: string } }): Promise<NotificationPrismaRow | null>;
  findMany(args: Record<string, unknown>): Promise<NotificationPrismaRow[]>;
  count(args?: Record<string, unknown>): Promise<number>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

/** 通用 delegate（权限解析用） */
interface AnyDelegate {
  findUnique(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  findMany(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
}

/**
 * Prisma 实现：notifications 表（数据字典 §3.18）
 */
@Injectable()
export class PrismaNotificationStore implements NotificationStore {
  constructor(@Inject(DB_CLIENT) private readonly client: PrismaClientLike) {}

  private get delegate(): NotificationDelegate {
    return (this.client as unknown as Record<string, NotificationDelegate>).notification;
  }

  /** 幂等插入：唯一冲突即视为重复投递（并发下也只有一个成功） */
  async insert(row: NotificationRow): Promise<boolean> {
    try {
      await this.delegate.create({
        data: {
          id: row.id,
          tenantId: BigInt(row.tenantId),
          userId: row.userId,
          kind: row.kind,
          level: row.level,
          title: row.title,
          content: row.content,
          refType: row.refType,
          refId: row.refId,
          traceId: row.traceId,
          dedupeKey: row.dedupeKey,
          readAt: row.readAt ? new Date(row.readAt) : null,
          createdAt: new Date(row.createdAt),
        },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async findById(id: string): Promise<NotificationRow | null> {
    const row = await this.delegate.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async page(query: NotificationQuery): Promise<{ total: number; items: NotificationRow[] }> {
    const where: Record<string, unknown> = { userId: query.userId };
    if (query.unreadOnly) where.readAt = null;
    const [total, rows] = await Promise.all([
      this.delegate.count({ where }),
      this.delegate.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { total, items: rows.map(toRecord) };
  }

  async countUnread(userId: string): Promise<number> {
    return this.delegate.count({ where: { userId, readAt: null } });
  }

  async markRead(id: string, userId: string, readAt: string): Promise<number> {
    const { count } = await this.delegate.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date(readAt) },
    });
    return count;
  }

  async markAllRead(userId: string, readAt: string): Promise<number> {
    const { count } = await this.delegate.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date(readAt) },
    });
    return count;
  }

  async remove(id: string, userId: string): Promise<boolean> {
    const { count } = await this.delegate.deleteMany({ where: { id, userId } });
    return count > 0;
  }

  async prune(userId: string, maxEntries: number): Promise<number> {
    const total = await this.delegate.count({ where: { userId } });
    if (total <= maxEntries) return 0;
    const stale = await this.delegate.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: total - maxEntries,
      select: { id: true },
    });
    const ids = stale.map((row) => row.id);
    if (ids.length === 0) return 0;
    const { count } = await this.delegate.deleteMany({ where: { id: { in: ids } } });
    return count;
  }

  async listUserIdsByPermission(code: string): Promise<string[]> {
    const models = this.client as unknown as Record<string, AnyDelegate>;
    const permission = await models.permission.findUnique({ where: { code } });
    const permissionId = permission?.id;
    if (typeof permissionId !== 'string') return [];
    const roleLinks = await models.rolePermission.findMany({ where: { permissionId } });
    const roleIds = roleLinks.map((link) => link.roleId).filter((id): id is string => typeof id === 'string');
    if (roleIds.length === 0) return [];
    const userLinks = await models.userRole.findMany({ where: { roleId: { in: roleIds } } });
    const userIds = [...new Set(userLinks.map((link) => link.userId).filter((id): id is string => typeof id === 'string'))];
    if (userIds.length === 0) return [];
    const users = await models.user.findMany({ where: { id: { in: userIds }, status: 1, deletedAt: null } });
    return users.map((user) => user.id).filter((id): id is string => typeof id === 'string');
  }
}

/** 唯一约束冲突判定（Prisma P2002；不引 @prisma/client 类型，按 name/code 判定） */
function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; name?: string; message?: string };
  if (candidate?.code === 'P2002') return true;
  const text = `${candidate?.name ?? ''} ${candidate?.message ?? ''}`;
  return /UniqueConstraint|unique constraint/i.test(text);
}

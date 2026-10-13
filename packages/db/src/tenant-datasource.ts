/*
 * @file 租户数据源路由（M8 T-M8-02，PRD-008 FR-02）
 * @description dedicated 隔离租户按上下文路由到独立库 PrismaClient：
 *   - resolve() 读 @fw/logger 请求上下文：tenantVerified + isolation=dedicated + dbUrl 三者齐备
 *     才走租户 client；shared / 未认证 / @IgnoreTenant 一律回退默认数据源；
 *   - 租户 client 按 tenantId 缓存复用；clientFactory 约定同步返回 client（返回 thenable 即报错），
 *     创建全程无 await，并发 resolve 天然串行、不会重复建连；
 *   - LRU 上限（maxClients）+ 空闲淘汰（idleTimeoutMs）双策略，淘汰即 $disconnect 防连接泄漏；
 *   - onModuleDestroy 全量断开（app.close() 触发，与优雅停机同链）。
 *   安全约束：dbUrl 只经进程内上下文传递，本类与 stats() 均不输出连接串。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/db
 */

import { getRequestContext } from '@fw/logger';
import type { PrismaClientLike } from './types.js';

/** 租户数据源配置 */
export interface TenantDataSourceOptions {
  /**
   * 按独立库连接串创建 client 的工厂（宿主提供，通常为
   * `new PrismaClient({ datasources: { db: { url } } })` 再包一层慢查询插桩）。
   * 约定：同步返回可用的 PrismaClientLike；返回 thenable 或抛错均视为建连失败
   * （不落缓存，后续请求重试）。
   */
  clientFactory: (dbUrl: string) => PrismaClientLike;
  /** 单进程租户 client 数上限，默认 32；超出按 LRU 淘汰最久未用 */
  maxClients?: number;
  /** 空闲淘汰时长（毫秒），默认 600000（10 分钟）；0 = 关闭空闲淘汰 */
  idleTimeoutMs?: number;
}

/** 路由统计（供 /metrics 与排查；不含连接串） */
export interface TenantDataSourceStats {
  /** 当前活跃租户 client 数 */
  active: number;
  /** 租户 client 数上限 */
  maxClients: number;
  /** 活跃租户 ID 列表（按最近使用排序） */
  tenantIds: string[];
  /** 累计创建 / 淘汰次数 */
  created: number;
  evicted: number;
}

/** 默认租户 client 数上限 */
const DEFAULT_MAX_CLIENTS = 32;

/** 默认空闲淘汰时长（毫秒） */
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

/** 空闲扫描间隔：取 idleTimeoutMs 的一半，至少 1s */
function scanIntervalMs(idleTimeoutMs: number): number {
  return Math.max(1000, Math.floor(idleTimeoutMs / 2));
}

/** 租户 client 缓存条目 */
interface TenantClientEntry {
  /** 租户 ID（Map 键的镜像，供 stats 使用） */
  tenantId: string;
  /** 已创建的 client */
  client: PrismaClientLike;
  /** 最近使用时间（LRU 键） */
  lastUsedAt: number;
}

/**
 * 租户数据源：按请求上下文在默认库与租户独立库之间选路。
 *
 * 用法（宿主侧）：
 * ```ts
 * const dataSource = new TenantDataSource(defaultClient, {
 *   clientFactory: (url) => withSlowQueryLog(new PrismaClient({ datasources: { db: { url } } })),
 * });
 * // 注入容器后，Repository 基类经 options.dataSource 自动选路
 * ```
 *
 * 事务说明：withTransaction 在事务开始时选路一次，事务内所有操作共享该 client 的连接，
 * 与单库行为一致（dedicated 租户的跨模型事务天然落在同一独立库内）。
 */
export class TenantDataSource {
  private readonly entries = new Map<string, TenantClientEntry>();

  private readonly maxClients: number;

  private readonly idleTimeoutMs: number;

  private evictTimer: NodeJS.Timeout | undefined;

  private createdCount = 0;

  private evictedCount = 0;

  /**
   * @param defaultClient 默认数据源（shared 租户 / 无上下文时的回退，通常即 DbModule 注入的 client）
   * @param options 路由配置
   */
  constructor(
    private readonly defaultClient: PrismaClientLike,
    private readonly options: TenantDataSourceOptions,
  ) {
    this.maxClients = Math.max(1, options.maxClients ?? DEFAULT_MAX_CLIENTS);
    this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  }

  /**
   * 解析当前请求应使用的 client。
   * 回退默认数据源的条件（任一）：无请求上下文 / 租户未认证 / ignoreTenant（跨租户维护）/
   * isolation 非 dedicated / 缺 dbUrl / 缺 tenantId。
   */
  async resolve(): Promise<PrismaClientLike> {
    const ctx = getRequestContext();
    if (!ctx?.tenantVerified || ctx.ignoreTenant === true) return this.defaultClient;
    if (ctx.tenantIsolation !== 'dedicated' || !ctx.tenantDbUrl) return this.defaultClient;
    const tenantId = ctx.tenantId ?? '';
    // 无 tenantId 的 dedicated 上下文视为异常：回退默认库并由上层 fail-closed 拦截，
    // 不在路由层静默放行（防御性分支，正常链路 tenantId 必现）
    if (!tenantId) return this.defaultClient;
    return this.clientFor(tenantId, ctx.tenantDbUrl);
  }

  /** 路由统计（不含连接串） */
  stats(): TenantDataSourceStats {
    const ordered = [...this.entries.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return {
      active: this.entries.size,
      maxClients: this.maxClients,
      tenantIds: ordered.map((entry) => entry.tenantId),
      created: this.createdCount,
      evicted: this.evictedCount,
    };
  }

  /**
   * 全量断开租户 client（优雅停机链：app.close() → onModuleDestroy）。
   * 单个断开失败不影响其余（汇总错误上抛）。
   */
  async disconnectAll(): Promise<void> {
    if (this.evictTimer) {
      clearInterval(this.evictTimer);
      this.evictTimer = undefined;
    }
    const entries = [...this.entries.values()];
    this.entries.clear();
    const failures: unknown[] = [];
    await Promise.all(
      entries.map(async (entry) => {
        try {
          await entry.client.$disconnect();
        } catch (error) {
          failures.push(error);
        }
      }),
    );
    if (failures.length > 0) {
      throw new Error(`TenantDataSource 断开 ${failures.length} 个租户 client 失败`);
    }
  }

  /** Nest 生命周期：app.close() 时断开全部租户连接（useValue 注入同样触发） */
  onModuleDestroy(): Promise<void> {
    return this.disconnectAll();
  }

  // ---------- 内部 ----------

  /** tenantId → client（get-or-create + LRU 维护；同步路径，无 await） */
  private clientFor(tenantId: string, dbUrl: string): PrismaClientLike {
    const existing = this.entries.get(tenantId);
    if (existing) {
      this.touch(existing);
      return existing.client;
    }
    const entry: TenantClientEntry = { tenantId, client: undefined as unknown as PrismaClientLike, lastUsedAt: Date.now() };
    this.entries.set(tenantId, entry);
    this.ensureEvictTimer();
    return this.create(entry, dbUrl);
  }

  /** 真正创建 client 并落缓存（同步；失败即清理条目，下次请求重试） */
  private create(entry: TenantClientEntry, dbUrl: string): PrismaClientLike {
    try {
      const client = this.options.clientFactory(dbUrl);
      if (client && typeof (client as { then?: unknown }).then === 'function') {
        throw new Error('TenantDataSource: clientFactory 必须同步返回 PrismaClientLike（不支持异步工厂）');
      }
      entry.client = client;
      entry.lastUsedAt = Date.now();
      this.createdCount += 1;
      // 建库后置队尾（Map 插入序 = LRU 序）
      this.touch(entry);
      this.evictIfNeeded();
      return client;
    } catch (error) {
      // 创建失败不落缓存：清理条目，允许后续请求重试
      if (this.entries.get(entry.tenantId) === entry) this.entries.delete(entry.tenantId);
      throw error;
    }
  }

  /** LRU 维护：命中即移到队尾 */
  private touch(entry: TenantClientEntry): void {
    entry.lastUsedAt = Date.now();
    this.entries.delete(entry.tenantId);
    this.entries.set(entry.tenantId, entry);
  }

  /** LRU 淘汰：超出上限时断开最久未用条目 */
  private evictIfNeeded(): void {
    while (this.entries.size > this.maxClients) {
      const oldestKey = this.entries.keys().next();
      if (oldestKey.done) return;
      const entry = this.entries.get(oldestKey.value);
      if (!entry?.client) return;
      this.entries.delete(oldestKey.value);
      this.evictedCount += 1;
      void entry.client.$disconnect().catch(() => undefined);
    }
  }

  /** 空闲淘汰定时器（unref，不阻塞进程退出） */
  private ensureEvictTimer(): void {
    if (this.idleTimeoutMs <= 0 || this.evictTimer) return;
    this.evictTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of [...this.entries.entries()]) {
        if (!entry.client) continue;
        if (now - entry.lastUsedAt >= this.idleTimeoutMs) {
          this.entries.delete(key);
          this.evictedCount += 1;
          void entry.client.$disconnect().catch(() => undefined);
        }
      }
    }, scanIntervalMs(this.idleTimeoutMs));
    this.evictTimer.unref();
  }
}

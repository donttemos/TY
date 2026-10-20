/*
 * @file 审计事件写入限流（PRD-015 FR-15-12 / ADR-0032 R6）
 * @description 拒绝/失败类事件由攻击者可控触发（暴力破解、越权扫描），若无上限会把审计表变成
 *   攻击者的「写入放大器」：每次失败一行，既污染取证，也拖慢在线查询。
 *   本工具按「主体 + 维度」在固定窗口内限额，超出部分丢弃（调用方仍照常抛错/拒绝业务），
 *   审计只保留前 N 条样本。
 *
 *   **容量是硬上限，不只是「清理过期桶的期望值」**：攻击者可以在同一分钟内不断更换维度键
 *   （`login:<ip>:<account>` 换账号、`authz:<user>:<perms>` 换权限串），这些新桶都还没过期，
 *   只清过期桶的话 Map 仍会一路涨。因此清理后若仍满，**拒绝新建桶并丢弃本条审计样本**
 *   （内存有界；丢弃可经 `stats().droppedForCapacity` 观测）。这是有意的取舍：防洪优先于
 *   样本完整性——被丢弃的样本由结构化日志兜底，而内存涨爆会让整个进程不可用。
 *
 *   清理本身也做了节流：容量满时每个新键都触发一次全表扫描 = O(n) 的 CPU 放大，
 *   与限流的初衷相反；现在同一时间窗内最多扫描一次。
 *
 *   进程内实现（Map）：多副本下各实例独立计数，实际落库量 = 单实例上限 × 副本数。
 *   对「防洪」目的足够；若将来要求全局精确配额，换 @fw/cache 计数器即可（接口不变）。
 * @author donttemo
 * @created 2026-10-20
 * @modified 2026-10-20 donttemo M15 安全加固：桶数量上限改为真正生效（满则拒建桶 + 丢弃计数），
 *   过期扫描加时间节流，避免「数千个不同账号」同时把内存与 CPU 一起放大
 * @module @fw/auth
 */

/** 单条限流桶 */
interface Bucket {
  /** 窗口起点（毫秒） */
  start: number;
  /** 窗口内已放行数 */
  count: number;
}

/** 默认窗口长度（毫秒，对齐 OQ-15-7 的「分钟」口径） */
const DEFAULT_WINDOW_MS = 60_000;

/** 默认单窗口放行上限（超出即丢弃审计，不丢弃业务行为） */
const DEFAULT_MAX = 3;

/** 默认桶数量上限：内存的真实上限（不是「清理后通常会降到多少」） */
const DEFAULT_MAX_BUCKETS = 5_000;

/** 过期扫描的最小间隔（毫秒）：容量满时避免每个新键都做一次全表扫描 */
const PRUNE_MIN_INTERVAL_MS = 1_000;

/**
 * 限流器构造选项
 */
export interface AuditEventThrottleOptions {
  /** 桶数量硬上限（默认 5000；测试注入小值即可验证有界性） */
  maxBuckets?: number;
}

/**
 * 限流器运行态快照（可观测性用：桶数与「因容量被丢弃的样本数」）
 */
export interface AuditEventThrottleStats {
  /** 当前桶数量（恒 ≤ maxBuckets） */
  buckets: number;
  /** 因容量上限被丢弃的审计样本累计数（>0 说明限流器本身在丢审计，需要调大上限或加副本） */
  droppedForCapacity: number;
}

/**
 * 审计事件限流器
 */
export class AuditEventThrottle {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxBuckets: number;
  /** 上次过期扫描时刻（0 = 从未扫描） */
  private lastPruneAt = 0;
  /** 因容量上限被丢弃的样本数 */
  private droppedForCapacity = 0;

  /**
   * @param options.maxBuckets 桶数量硬上限
   */
  constructor(options: AuditEventThrottleOptions = {}) {
    this.maxBuckets = Math.max(1, Math.floor(options.maxBuckets ?? DEFAULT_MAX_BUCKETS));
  }

  /**
   * 判断本次事件是否允许落审计
   * @param key 维度键（如 `authz:<userId>:<permissions>` / `login:<ip>:<account>`）
   * @param max 单窗口上限
   * @param windowMs 窗口长度
   * @param now 当前时间（测试注入）
   * @returns true = 允许落库；false = 超限丢弃（含「限流器容量已满」这一情形）
   */
  allow(key: string, max = DEFAULT_MAX, windowMs = DEFAULT_WINDOW_MS, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (bucket && now - bucket.start < windowMs) {
      bucket.count += 1;
      return bucket.count <= max;
    }
    // 新键或过期窗口：先确保容量（过期键由 set 原地替换，不占新位置）
    if (!this.ensureCapacity(now, windowMs, bucket === undefined)) return false;
    this.buckets.set(key, { start: now, count: 1 });
    return true;
  }

  /** 清空全部桶与计数器（测试与热重载用） */
  reset(): void {
    this.buckets.clear();
    this.lastPruneAt = 0;
    this.droppedForCapacity = 0;
  }

  /** 运行态快照（桶数恒 ≤ maxBuckets） */
  stats(): AuditEventThrottleStats {
    return { buckets: this.buckets.size, droppedForCapacity: this.droppedForCapacity };
  }

  /**
   * 容量检查：满则先清理过期桶；清理后仍满则拒绝新建（丢弃本条样本）
   * @param now 当前时间
   * @param windowMs 窗口长度
   * @param isNewKey 是否为新维度键（已存在的过期键原地替换，不占新位置，无需容量）
   */
  private ensureCapacity(now: number, windowMs: number, isNewKey: boolean): boolean {
    if (!isNewKey) return true;
    if (this.buckets.size < this.maxBuckets) return true;
    this.prune(now, windowMs);
    if (this.buckets.size < this.maxBuckets) return true;
    this.droppedForCapacity += 1;
    return false;
  }

  /**
   * 惰性清理：仅在桶数超限时扫描，且同一时间窗内最多一次（摊薄成本）
   * @param now 当前时间
   * @param windowMs 窗口长度
   */
  private prune(now: number, windowMs: number): void {
    const interval = Math.min(windowMs, PRUNE_MIN_INTERVAL_MS);
    // 时钟回拨（now < lastPruneAt）时不再依赖「距上次多久」，直接扫描并把基准拉回当前时间，
    // 否则可能长时间认为「刚扫过」而一直跳过清理
    if (this.lastPruneAt !== 0 && now >= this.lastPruneAt && now - this.lastPruneAt < interval) return;
    this.lastPruneAt = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.start >= windowMs) this.buckets.delete(key);
    }
  }
}

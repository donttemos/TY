/*
 * @file 审计事件写入限流（PRD-015 FR-15-12 / ADR-0032 R6）
 * @description 拒绝/失败类事件由攻击者可控触发（暴力破解、越权扫描），若无上限会把审计表变成
 *   攻击者的「写入放大器」：每次失败一行，既污染取证，也拖慢在线查询。
 *   本工具按「主体 + 维度」在固定窗口内限额，超出部分丢弃（调用方仍照常抛错/拒绝业务），
 *   审计只保留前 N 条样本。
 *
 *   进程内实现（Map）：多副本下各实例独立计数，实际落库量 = 单实例上限 × 副本数。
 *   对「防洪」目的足够；若将来要求全局精确配额，换 @fw/cache 计数器即可（接口不变）。
 * @author donttemo
 * @created 2026-10-20
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

/** 桶数量上限：超限时触发一次过期清理，避免 Map 无界增长 */
const MAX_BUCKETS = 5_000;

/**
 * 审计事件限流器
 */
export class AuditEventThrottle {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * 判断本次事件是否允许落审计
   * @param key 维度键（如 `authz:<userId>:<permissions>` / `login:<ip>:<account>`）
   * @param max 单窗口上限
   * @param windowMs 窗口长度
   * @param now 当前时间（测试注入）
   * @returns true = 允许落库；false = 超限丢弃
   */
  allow(key: string, max = DEFAULT_MAX, windowMs = DEFAULT_WINDOW_MS, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      this.prune(now, windowMs);
      this.buckets.set(key, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= max;
  }

  /** 清空全部桶（测试与热重载用） */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * 惰性清理：仅在桶数超限时扫描一次，摊薄成本
   * @param now 当前时间
   * @param windowMs 窗口长度
   */
  private prune(now: number, windowMs: number): void {
    if (this.buckets.size <= MAX_BUCKETS) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.start >= windowMs) this.buckets.delete(key);
    }
  }
}

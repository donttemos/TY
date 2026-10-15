/*
 * @file 指标采集与 Prometheus 文本渲染
 * @description 命中率、平均耗时、错误数、降级数、单飞合并数、大 key 拒绝数等计数（PRD-004 FR-10）；
 *   指标只增不减，`/metrics` 直接渲染为 Prometheus 文本格式，供抓取与压测断言（AC-008）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import type { CacheDriverName, CacheMetricsSnapshot } from './types.js';
import type { RateLimitSnapshot } from './rate-limit.js';

/** 指标采集器：纯计数 + 耗时累加，线程内单例 */
export class CacheMetrics {
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private tagInvalidations = 0;
  private singleFlightMerged = 0;
  private degradations = 0;
  private errors = 0;
  private oversizedRejected = 0;
  private latencyMs = 0;
  private operations = 0;

  /** 记录一次命中 */
  hit(): void {
    this.hits++;
  }

  /** 记录一次未命中 */
  miss(): void {
    this.misses++;
  }

  /** 记录一次写入 */
  set(): void {
    this.sets++;
  }

  /**
   * 记录一次删除
   * @param count 删除数量
   */
  delete(count = 1): void {
    this.deletes += count;
  }

  /** 记录一次标签失效 */
  tagInvalidation(): void {
    this.tagInvalidations++;
  }

  /** 记录被单飞合并掉的并发回源数 */
  singleFlight(): void {
    this.singleFlightMerged++;
  }

  /** 记录一次降级（fail-open 生效） */
  degradation(): void {
    this.degradations++;
  }

  /** 记录一次错误 */
  error(): void {
    this.errors++;
  }

  /** 记录一次大 key 拒绝 */
  oversized(): void {
    this.oversizedRejected++;
  }

  /**
   * 记录一次操作耗时
   * @param durationMs 耗时（毫秒）
   */
  observe(durationMs: number): void {
    this.latencyMs += durationMs;
    this.operations++;
  }

  /**
   * 快照
   * @param driver 驱动名
   */
  snapshot(driver: CacheDriverName): CacheMetricsSnapshot {
    return {
      driver,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      tagInvalidations: this.tagInvalidations,
      singleFlightMerged: this.singleFlightMerged,
      degradations: this.degradations,
      errors: this.errors,
      oversizedRejected: this.oversizedRejected,
      latencyMs: this.latencyMs,
      operations: this.operations,
    };
  }

  /**
   * 命中率：hits / (hits + misses)；无操作时返回 0
   * @param snapshot 指标快照
   */
  static hitRate(snapshot: CacheMetricsSnapshot): number {
    const total = snapshot.hits + snapshot.misses;
    return total === 0 ? 0 : snapshot.hits / total;
  }

  /**
   * 渲染 Prometheus 文本格式（含命中率派生指标）
   * @param snapshot 指标快照
   */
  static render(snapshot: CacheMetricsSnapshot, rateLimit?: RateLimitSnapshot): string {
    const lines: string[] = [];
    const gauge = (name: string, help: string, value: number): void => {
      lines.push(`# HELP fw_cache_${name} ${help}`);
      lines.push(`# TYPE fw_cache_${name} gauge`);
      lines.push(`fw_cache_${name} ${value}`);
    };
    lines.push(`# HELP fw_cache_info 缓存驱动信息`);
    lines.push(`# TYPE fw_cache_info gauge`);
    lines.push(`fw_cache_info{driver="${snapshot.driver}"} 1`);
    gauge('hits_total', '缓存命中总次数（含空值占位命中）', snapshot.hits);
    gauge('misses_total', '缓存未命中总次数', snapshot.misses);
    gauge('sets_total', '缓存写入总次数', snapshot.sets);
    gauge('deletes_total', '缓存删除总次数', snapshot.deletes);
    gauge('tag_invalidations_total', '标签失效总次数', snapshot.tagInvalidations);
    gauge('single_flight_merged_total', '被单飞合并的并发回源数', snapshot.singleFlightMerged);
    gauge('degradations_total', '降级（fail-open）总次数', snapshot.degradations);
    gauge('errors_total', '缓存操作错误总次数', snapshot.errors);
    gauge('oversized_rejected_total', '大 key 拒绝写入总次数', snapshot.oversizedRejected);
    gauge('hit_rate', '命中率 hits/(hits+misses)', Number(CacheMetrics.hitRate(snapshot).toFixed(6)));
    gauge('avg_latency_ms', '平均操作耗时（毫秒）', snapshot.operations === 0 ? 0 : Number((snapshot.latencyMs / snapshot.operations).toFixed(3)));
    if (rateLimit) {
      lines.push('# HELP fw_rate_limit_allowed_total 限流放行总数（令牌桶扣减成功）');
      lines.push('# TYPE fw_rate_limit_allowed_total counter');
      lines.push(`fw_rate_limit_allowed_total ${rateLimit.allowed}`);
      lines.push('# HELP fw_rate_limit_denied_total 限流拒绝总数（429）');
      lines.push('# TYPE fw_rate_limit_denied_total counter');
      lines.push(`fw_rate_limit_denied_total ${rateLimit.denied}`);
      lines.push('# HELP fw_rate_limit_whitelisted_total 白名单豁免总数');
      lines.push('# TYPE fw_rate_limit_whitelisted_total counter');
      lines.push(`fw_rate_limit_whitelisted_total ${rateLimit.whitelisted}`);
      lines.push('# HELP fw_rate_limit_dry_run_passed_total 灰度模式超限放行总数');
      lines.push('# TYPE fw_rate_limit_dry_run_passed_total counter');
      lines.push(`fw_rate_limit_dry_run_passed_total ${rateLimit.dryRunPassed}`);
      lines.push('# HELP fw_rate_limit_fail_open_total 存储故障放行总数（fail-open）');
      lines.push('# TYPE fw_rate_limit_fail_open_total counter');
      lines.push(`fw_rate_limit_fail_open_total ${rateLimit.failOpen}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

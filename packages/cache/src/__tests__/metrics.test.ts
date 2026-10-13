/*
 * @file 指标采集与 Prometheus 渲染单测
 * @description 验证计数累计、命中率派生、平均耗时与文本格式关键行（AC-008：/metrics 可见命中率）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { describe, expect, it } from 'vitest';
import { CacheMetrics } from '../metrics.js';

describe('@fw/cache · 指标', () => {
  it('计数累计并生成快照', () => {
    const metrics = new CacheMetrics();
    metrics.hit();
    metrics.hit();
    metrics.miss();
    metrics.set();
    metrics.delete(3);
    metrics.tagInvalidation();
    metrics.singleFlight();
    metrics.degradation();
    metrics.error();
    metrics.oversized();
    metrics.observe(10);
    metrics.observe(30);

    const snapshot = metrics.snapshot('redis');
    expect(snapshot).toMatchObject({
      driver: 'redis',
      hits: 2,
      misses: 1,
      sets: 1,
      deletes: 3,
      tagInvalidations: 1,
      singleFlightMerged: 1,
      degradations: 1,
      errors: 1,
      oversizedRejected: 1,
      latencyMs: 40,
      operations: 2,
    });
    expect(CacheMetrics.hitRate(snapshot)).toBeCloseTo(2 / 3, 5);
    // delete 默认参数
    metrics.delete();
    expect(metrics.snapshot('redis').deletes).toBe(4);
  });

  it('无操作时命中率为 0，平均耗时为 0', () => {
    const snapshot = new CacheMetrics().snapshot('memory');
    expect(CacheMetrics.hitRate(snapshot)).toBe(0);
    const text = CacheMetrics.render(snapshot);
    expect(text).toContain('fw_cache_hit_rate 0');
    expect(text).toContain('fw_cache_avg_latency_ms 0');
  });

  it('渲染 Prometheus 文本格式（含 driver 标签与命中率）', () => {
    const metrics = new CacheMetrics();
    metrics.hit();
    metrics.hit();
    metrics.hit();
    metrics.miss();
    metrics.observe(20);

    const text = CacheMetrics.render(metrics.snapshot('memory'));
    expect(text).toContain('# TYPE fw_cache_hits_total gauge');
    expect(text).toContain('fw_cache_hits_total 3');
    expect(text).toContain('fw_cache_misses_total 1');
    expect(text).toContain('fw_cache_hit_rate 0.75');
    expect(text).toContain('fw_cache_avg_latency_ms 20');
    expect(text).toContain('fw_cache_info{driver="memory"} 1');
    expect(text.endsWith('\n')).toBe(true);
  });
});

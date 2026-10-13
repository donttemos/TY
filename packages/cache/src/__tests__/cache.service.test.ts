/*
 * @file CacheService 单测（统一接口 + 三防护 + 降级 + 指标）
 * @description 逐条覆盖 PRD-004 的 P0 验收：命中回源（TC-CACHE-002）、标签失效（003）、单飞（004）、
 *   空值占位（005）、TTL 抖动（006）、降级与回切（007/008）、大 key 拒绝（010），以及 fail-closed 抛 9002。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { describe, expect, it, vi } from 'vitest';
import { CacheService } from '../cache.service.js';
import { CacheKeyError, CacheUnavailableError } from '../errors.js';
import { CacheMetrics } from '../metrics.js';
import { MemoryCacheStore } from '../drivers/memory.driver.js';
import type { CacheRuntimeOptions } from '../types.js';
import { FaultyStore, makeOptions } from './test-helpers.js';

/** 构造服务（memory 驱动 + 指定覆盖配置） */
function makeService(
  overrides: Partial<CacheRuntimeOptions> = {},
  deps: { store?: MemoryCacheStore | FaultyStore; metrics?: CacheMetrics } = {},
): {
  cache: CacheService;
  store: MemoryCacheStore | FaultyStore;
  metrics: CacheMetrics;
} {
  const store = deps.store ?? new MemoryCacheStore();
  const metrics = deps.metrics ?? new CacheMetrics();
  const cache = new CacheService({ store, options: makeOptions(overrides), metrics });
  return { cache, store, metrics };
}

describe('@fw/cache · CacheService 统一接口', () => {
  it('写入自动补全局前缀，读取得同值（TC-CACHE-002 基础）', async () => {
    const { cache, store } = makeService();
    await cache.set('user:1', { id: 1 });
    expect(await cache.get<{ id: number }>('user:1')).toEqual({ id: 1 });
    expect(await store.get('test:user:1')).toBeTruthy();
    expect(cache.prefix).toBe('test');
    expect(cache.driver).toBe('memory');
  });

  it('非法键在读/写入口即被拒绝', async () => {
    const { cache } = makeService();
    await expect(cache.get('bad key')).rejects.toThrow(CacheKeyError);
    await expect(cache.set('bad key', 1)).rejects.toThrow(CacheKeyError);
  });

  it('miss → 回源写缓存 → 二次命中不回源，命中率指标递增', async () => {
    const { cache, metrics } = makeService();
    const loader = vi.fn(async () => 'value');
    expect(await cache.wrap('k', 60, loader)).toBe('value');
    expect(await cache.wrap('k', 60, loader)).toBe('value');
    expect(loader).toHaveBeenCalledTimes(1);
    const snapshot = cache.metricsSnapshot();
    expect(snapshot.hits).toBe(1);
    expect(snapshot.misses).toBe(1);
    expect(snapshot.sets).toBe(1);
    expect(snapshot.operations).toBeGreaterThan(0);
    expect(CacheMetrics.hitRate(snapshot)).toBeCloseTo(0.5, 5);
    expect(metrics.snapshot('memory').misses).toBe(1);
  });

  it('wrap 在 100 并发同 key 下只回源一次（TC-CACHE-004 防击穿）', async () => {
    const { cache } = makeService();
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'hot';
    };
    const results = await Promise.all(Array.from({ length: 100 }, () => cache.wrap('hot', 60, loader)));
    expect(calls).toBe(1);
    expect(results.every((r) => r === 'hot')).toBe(true);
    const snapshot = cache.metricsSnapshot();
    expect(snapshot.singleFlightMerged).toBe(99);
  });

  it('回源返回 null/undefined 写空值占位，10 并发仍只回源一次（TC-CACHE-005 防穿透）', async () => {
    const { cache } = makeService();
    let calls = 0;
    const loader = async (): Promise<null> => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return null;
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.wrap('ghost', 60, loader)));
    expect(calls).toBe(1);
    expect(results.every((r) => r === undefined)).toBe(true);
    // 占位存在（has 为 true），但 get 返回 undefined；再次回源不会发生
    expect(await cache.has('ghost')).toBe(true);
    expect(await cache.get('ghost')).toBeUndefined();
    const loadedAgain = await cache.wrap('ghost', 60, loader);
    expect(loadedAgain).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('写入时按抖动比例扩展 TTL（TC-CACHE-006 防雪崩）', async () => {
    const store = new MemoryCacheStore();
    const spy = vi.spyOn(store, 'set');
    const { cache } = makeService({ ttlJitter: 0.5 }, { store });
    await cache.set('j', 'v', { ttlSeconds: 100 });
    const ttlMs = spy.mock.calls[0][2];
    expect(ttlMs).toBeGreaterThanOrEqual(50_000);
    expect(ttlMs).toBeLessThanOrEqual(150_000);
  });

  it('无抖动时 TTL 精确等于配置值', async () => {
    const store = new MemoryCacheStore();
    const spy = vi.spyOn(store, 'set');
    const { cache } = makeService({ ttlJitter: 0 }, { store });
    await cache.set('j', 'v', { ttlSeconds: 12 });
    expect(spy.mock.calls[0][2]).toBe(12_000);
  });

  it('invalidateTag 使该标签下所有键失效（TC-CACHE-003）', async () => {
    const { cache } = makeService();
    await cache.set('user:1:profile', { id: 1 }, { tags: ['user:1'] });
    await cache.set('user:1:roles', ['admin'], { tags: ['user:1', 'role'] });
    await cache.set('user:2:profile', { id: 2 }, { tags: ['user:2'] });
    const removed = await cache.invalidateTag('user:1');
    expect(removed).toBe(2);
    expect(await cache.get('user:1:profile')).toBeUndefined();
    expect(await cache.get('user:1:roles')).toBeUndefined();
    expect(await cache.get('user:2:profile')).toEqual({ id: 2 });
    expect(cache.metricsSnapshot().tagInvalidations).toBe(1);
    // 再次失效同一标签：映射已清理，返回 0
    expect(await cache.invalidateTag('user:1')).toBe(0);
  });

  it('mset / mget / del / has / expire 批量语义', async () => {
    const { cache } = makeService({ defaultTtlSeconds: 600 });
    await cache.mset([
      { key: 'a', value: 1 },
      { key: 'b', value: 2, tags: ['grp'] },
    ]);
    const map = await cache.mget<number>(['a', 'b', 'missing']);
    expect([...map.entries()]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(await cache.has('a')).toBe(true);
    expect(await cache.expire('a', 600)).toBe(true);
    expect(await cache.expire('missing', 600)).toBe(false);
    await cache.del(['a', 'b']);
    expect(await cache.has('a')).toBe(false);
    expect(await cache.mget(['a']).then((m) => m.size)).toBe(0);
  });

  it('del 接受单个键；空数组为无操作', async () => {
    const { cache } = makeService();
    await cache.set('single', 1);
    await cache.del('single');
    expect(await cache.has('single')).toBe(false);
    await expect(cache.del([])).resolves.toBeUndefined();
  });

  it('回源异常上抛（不吞业务错误），且不写缓存', async () => {
    const { cache } = makeService();
    await expect(
      cache.wrap('boom', 60, async () => {
        throw new Error('业务回源失败');
      }),
    ).rejects.toThrow('业务回源失败');
    expect(await cache.has('boom')).toBe(false);
  });

  it('回源超时（loaderTimeoutMs）上抛', async () => {
    const { cache } = makeService();
    await expect(
      cache.wrap('slow', 60, () => new Promise((resolve) => setTimeout(() => resolve('late'), 200)), { loaderTimeoutMs: 20 }),
    ).rejects.toThrow(/回源超时/);
  });
});

describe('@fw/cache · 降级与 fail-closed', () => {
  it('依赖故障时 fail-open：读返回 undefined、写忽略并计降级（TC-CACHE-007）', async () => {
    const store = new FaultyStore();
    const { cache } = makeService({ failOpen: true }, { store });
    await cache.set('k', 'v');
    store.broken = true;
    expect(await cache.get('k')).toBeUndefined();
    await expect(cache.set('k', 'v2')).resolves.toBeUndefined();
    expect(await cache.ping()).toBe(false);
    expect(await cache.has('k')).toBe(false);
    const snapshot = cache.metricsSnapshot();
    expect(snapshot.degradations).toBeGreaterThan(0);
    expect(snapshot.errors).toBeGreaterThan(0);
  });

  it('依赖恢复后自动回切使用缓存，无脏数据（TC-CACHE-008）', async () => {
    const store = new FaultyStore();
    const { cache } = makeService({ failOpen: true }, { store });
    await cache.set('k', 'v1');
    store.broken = true;
    expect(await cache.get('k')).toBeUndefined();
    store.broken = false;
    expect(await cache.get('k')).toBe('v1');
    expect(await cache.ping()).toBe(true);
  });

  it('fail-closed 时抛 CacheUnavailableError（9002 / 503 语义）', async () => {
    const store = new FaultyStore();
    const { cache } = makeService({ failOpen: false }, { store });
    store.broken = true;
    await expect(cache.get('k')).rejects.toBeInstanceOf(CacheUnavailableError);
    await expect(cache.set('k', 'v')).rejects.toThrow(/9002|缓存/);
    await expect(cache.lock('job')).rejects.toBeInstanceOf(CacheUnavailableError);
    const error = await cache.get('k').catch((e: CacheUnavailableError) => e);
    expect(error.http).toBe(503);
  });

  it('调用级 failOpen 覆盖全局配置（写路径不受缓存故障影响）', async () => {
    const store = new FaultyStore();
    const { cache } = makeService({ failOpen: false }, { store });
    store.broken = true;
    await expect(cache.set('k', 'v', { failOpen: true })).resolves.toBeUndefined();
  });

  it('值超过 CACHE_MAX_VALUE_BYTES 拒绝写入并计指标（TC-CACHE-010）', async () => {
    const { cache, store } = makeService({ maxValueBytes: 1024 });
    await cache.set('big', 'x'.repeat(4096));
    expect(await store.get('test:big')).toBeUndefined();
    expect(cache.metricsSnapshot().oversizedRejected).toBe(1);
    // 边界内正常写入
    await cache.set('small', 'ok');
    expect(await cache.get('small')).toBe('ok');
  });
});

describe('@fw/cache · 分布式锁与观测', () => {
  it('lock 互斥：第二次获取失败（不等待）', async () => {
    const { cache } = makeService();
    const first = await cache.lock('cron:cleanup');
    expect(first).not.toBeNull();
    expect(await cache.lock('cron:cleanup')).toBeNull();
    expect(await first!.release()).toBe(true);
    const second = await cache.lock('cron:cleanup');
    expect(second).not.toBeNull();
    await second!.release();
  });

  it('withLock 未获取到锁时不执行业务（集群单跑语义）', async () => {
    const { cache } = makeService();
    const hold = await cache.lock('job');
    const fn = vi.fn(async () => 'ran');
    const skipped = await cache.withLock('job', 30, fn);
    expect(skipped).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
    await hold!.release();
    const run = await cache.withLock('job', 30, fn);
    expect(run).toEqual({ acquired: true, value: 'ran' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('size 与 close 透传存储层', async () => {
    const { cache } = makeService();
    await cache.set('a', 1);
    expect(await cache.size()).toBe(1);
    await cache.close();
    expect(await cache.size()).toBe(0);
  });
});

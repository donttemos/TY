/*
 * @file CacheService 单测（统一接口 + 三防护 + 降级 + 指标）
 * @description 逐条覆盖 PRD-004 的 P0 验收：命中回源（TC-CACHE-002）、标签失效（003）、单飞（004）、
 *   空值占位（005）、TTL 抖动（006）、降级与回切（007/008）、大 key 拒绝（010），以及 fail-closed 抛 9002。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复配套：新增 C-01 回归（失效×并发写入交错
 *   后无孤儿不变式）、C-03 回归（fail-open/fail-closed 失效失败不销毁索引）、A-04 回归（带标签
 *   写入走 setWithTags 原子端口方法）。
 * @modified 2026-10-18 donttemo 复核修复配套（P2）：新增 lock 的 waitMs fail-fast 用例
 *   （非法参数不得被 fail-open 降级成 null）。
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

  it('C-01 回归：失效与并发写入交错后，任何存活值都必须仍可经标签失效（无孤儿）', async () => {
    const { cache } = makeService();
    // 修复前的竞态：setRaw 写值与标签登记两步分离，登记落在失效成员快照之后、索引删除之前
    // → 键成为孤儿（get 有值、再次 invalidateTag 却返回 0）。修复后写+登记原子、失效原子，
    // 两者全序串行，该不变式必须恒成立。
    for (let i = 0; i < 60; i++) {
      await Promise.all([cache.set('k', `v${i}`, { tags: ['t'] }), cache.invalidateTag('t')]);
      const value = await cache.get('k');
      const removed = await cache.invalidateTag('t');
      if (value !== undefined) {
        expect(removed).toBe(1);
      } else {
        expect(removed).toBe(0);
      }
    }
  }, 15_000);

  it('C-03 回归：fail-open 下成员读取失败时，失效整体未发生（索引不销毁）', async () => {
    const store = new FaultyStore();
    const { cache } = makeService({ failOpen: true }, { store });
    await cache.set('k', 'v', { tags: ['t'] });
    // 仅让 smembers 类读取失败（invalidateByTag），del 正常——修复前：
    // smembers 降级为 [] 被当成「没有成员」，cleanup 仍会删掉索引，留下不可失效的残留数据
    store.failWhen = (method) => method === 'invalidateByTag';
    expect(await cache.invalidateTag('t')).toBe(0);
    store.failWhen = () => false;
    // 数据仍在，索引仍有效——可正常失效
    expect(await cache.get('k')).toBe('v');
    expect(await cache.invalidateTag('t')).toBe(1);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('C-03 回归：fail-closed 下失效失败抛 9002 且索引不销毁', async () => {
    const store = new FaultyStore();
    const { cache } = makeService({ failOpen: false }, { store });
    await cache.set('k', 'v', { tags: ['t'] });
    store.failWhen = (method) => method === 'invalidateByTag';
    await expect(cache.invalidateTag('t')).rejects.toBeInstanceOf(CacheUnavailableError);
    store.failWhen = () => false;
    expect(await cache.get('k')).toBe('v');
    expect(await cache.invalidateTag('t')).toBe(1);
  });

  it('A-04 回归：带标签写入走原子端口方法（无「值已写入、标签未登记」半程）', async () => {
    const store = new MemoryCacheStore();
    const setWithTagsSpy = vi.spyOn(store, 'setWithTags');
    const setSpy = vi.spyOn(store, 'set');
    const { cache } = makeService({}, { store });
    await cache.set('k', 'v', { tags: ['t1', 't2'] });
    // 带标签写入必须走 setWithTags（单次原子），不再先 set 后逐个 sadd
    expect(setWithTagsSpy).toHaveBeenCalledTimes(1);
    expect(setWithTagsSpy.mock.calls[0][3].map((tag) => tag.tagKey)).toEqual(['test:__tag__:t1', 'test:__tag__:t2']);
    expect(setSpy).not.toHaveBeenCalled();
    // 两个标签都能失效到该键
    expect(await cache.invalidateTag('t1')).toBe(1);
    await cache.set('k2', 'v2', { tags: ['t2'] });
    expect(await cache.invalidateTag('t2')).toBe(1);
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

describe('@fw/cache · 配置边界（A-03）', () => {
  it.each([
    ['负数 TTL', -1],
    ['零 TTL', 0],
    ['NaN TTL', Number.NaN],
    ['无限 TTL', Number.POSITIVE_INFINITY],
  ])('set 拒绝%s（不再被钳到 1ms 静默写入）', async (_label, ttlSeconds) => {
    const { cache, store } = makeService();
    await expect(cache.set('config:bad-ttl', 'v', { ttlSeconds: ttlSeconds as number })).rejects.toThrow(/必须为正数/);
    await expect(cache.set('config:bad-null-ttl', null, { nullTtlSeconds: -5 })).rejects.toThrow(/必须为正数/);
    await expect(cache.expire('config:bad-expire', -1)).rejects.toThrow(/必须为正数/);
    await expect(cache.lock('config:bad-lock', 0)).rejects.toThrow(/必须为正数/);
    expect(await store.get('test:config:bad-ttl')).toBeUndefined();
  });

  it('P2 复核（2026-10-18）：lock 的非法 waitMs fail-fast（不被 fail-open 降级成 null）', async () => {
    const { cache, store } = makeService();
    await expect(cache.lock('config:bad-wait', undefined, { waitMs: -1 })).rejects.toThrow(/waitMs/);
    await expect(cache.lock('config:bad-wait', undefined, { waitMs: Number.NaN })).rejects.toThrow(/waitMs/);
    expect(await store.exists('test:lock:config:bad-wait')).toBe(false);
  });

  it.each([
    [{ ttlJitter: -0.1 }],
    [{ ttlJitter: 1.1 }],
    [{ ttlJitter: Number.NaN }],
    [{ lockTtlSeconds: 0 }],
    [{ lockTtlSeconds: -1 }],
    [{ defaultTtlSeconds: 0 }],
    [{ nullTtlSeconds: Number.POSITIVE_INFINITY }],
    [{ slowMs: -1 }],
  ])('updateRuntimeOptions 拒绝非法热更 %#', (patch) => {
    const { cache } = makeService();
    expect(() => cache.updateRuntimeOptions(patch as never)).toThrow(/非法/);
  });

  it('合法热更仍正常生效（校验不误伤）', () => {
    const { cache } = makeService();
    expect(() => cache.updateRuntimeOptions({ ttlJitter: 0.2, lockTtlSeconds: 60, slowMs: 100 })).not.toThrow();
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

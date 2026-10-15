/*
 * @file 运行时选项热更测试（M9/PRD-009 FR-09）
 * @description 验证 updateRuntimeOptions 的生效路径：默认 TTL / 空值 TTL 即刻作用于新写入
 *   （旧条目按原 TTL 过期、新条目存活越过旧 TTL 边界）、lockTtl 同步刷新锁管理器（新锁句柄带新 TTL）。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/cache
 */
import { describe, expect, it } from 'vitest';
import { CacheService } from '../cache.service.js';
import { MemoryCacheStore } from '../drivers/memory.driver.js';
import { makeOptions } from './test-helpers.js';

/** 等待毫秒 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('CacheService · updateRuntimeOptions（配置中心热更生效路径）', () => {
  it('defaultTtlSeconds 热更后，新写入按新默认值存活越过旧 TTL 边界，旧条目按原 TTL 过期', async () => {
    const cache = new CacheService({ store: new MemoryCacheStore(), options: makeOptions({ defaultTtlSeconds: 1 }) });
    await cache.set('old', 'v1');

    cache.updateRuntimeOptions({ defaultTtlSeconds: 60 });
    await cache.set('fresh', 'v2');
    await sleep(1100);

    await expect(cache.get('old')).resolves.toBeUndefined();
    await expect(cache.get('fresh')).resolves.toBe('v2');
  }, 10_000);

  it('lockTtlSeconds 热更同步刷新锁管理器：新获取的锁句柄带新 TTL', async () => {
    const cache = new CacheService({ store: new MemoryCacheStore(), options: makeOptions({ lockTtlSeconds: 1 }) });

    cache.updateRuntimeOptions({ lockTtlSeconds: 30 });
    // 不显式传 TTL：走更新后的默认 lockTtlSeconds（热更生效路径的行为证明）
    const lock = await cache.lock('res');

    expect(lock).not.toBeNull();
    expect((lock as { ttlMs: number }).ttlMs).toBe(30 * 1000);
    await (lock as { release: () => Promise<boolean> }).release();
  });

  it('nullTtlSeconds 热更后，新空值占位按新 TTL 存活越过旧边界', async () => {
    const cache = new CacheService({ store: new MemoryCacheStore(), options: makeOptions({ nullTtlSeconds: 1 }) });
    await cache.set('ghost-old', null);

    cache.updateRuntimeOptions({ nullTtlSeconds: 60 });
    await cache.set('ghost-new', null);
    await sleep(1100);

    const oldEntry = await cache.read('ghost-old');
    const newEntry = await cache.read('ghost-new');
    expect(oldEntry.hit).toBe(false);
    expect(newEntry.hit).toBe(true);
    expect(newEntry.kind).toBe('negative');
  }, 10_000);
});

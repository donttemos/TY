/*
 * @file CacheStorePort 跨驱动契约测试（A-01 配套，回归测试设计 §9）
 * @description 同一组断言对 memory 与 redis（Fake 客户端）两个驱动运行，锁定端口契约的可观察
 *   语义一致性：读写/TTL/集合/条件操作/类型冲突（WRONGTYPE 对齐）/原子标签方法。
 *   注意（设计 §9.4 / 最后四点之 3）：Fake 只验证驱动调用映射与内存模型语义，不能替代
 *   真实 Redis 的服务端原子性验证——真 Redis 单实例集成测试已由 `redis-integration.test.ts`
 *   落地并挂 CI（redis:7 service 容器，门控 CACHE_REDIS_INTEGRATION_URL）；cluster 兼容限制与
 *   策略见 ADR-0028；三档验证矩阵见 docs/90-release-v0.6.0.md §7。
 * @modified 2026-10-18 donttemo 复核修复（P1）配套：新增 setWithTags 写前预检两条跨驱动契约
 *   （标签键类型冲突 / 标签键撞值键 ⇒ 零写入），锁定两驱动同一失败语义。
 * @modified 2026-10-19 donttemo P1 加固配套：新增「幽灵索引（索引成员指向已删键）⇒ invalidateByTag
 *   返回实际删除数 0」契约——此前 redis Lua 返回成员个数、memory 返回实际删除数，幽灵场景不一致。
 * @author donttemo
 * @created 2026-10-17
 * @module @fw/cache
 */

import { describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../drivers/memory.driver.js';
import { RedisCacheStore } from '../drivers/redis.driver.js';
import type { CacheStorePort } from '../store.port.js';
import { FakeRedisClient } from './test-helpers.js';

/** 短睡眠（TTL 过期验证用） */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 共享契约测试工厂（设计 §9.1）：两个驱动共用同一组断言，不给各自写含义不同的版本 */
function storeContract(name: string, createStore: () => CacheStorePort): void {
  describe(`CacheStorePort 契约 · ${name}`, () => {
    it('mget 保留输入顺序，缺失键返回 undefined；mget([]) 为空数组', async () => {
      const store = createStore();
      await store.set('a', 'A', 10_000);
      await store.set('b', 'B', 10_000);
      expect(await store.mget(['b', 'missing', 'a'])).toEqual(['B', undefined, 'A']);
      expect(await store.mget([])).toEqual([]);
    });

    it('del 幂等并返回实际删除数量；del([]) 为 0', async () => {
      const store = createStore();
      await store.set('a', 'A', 10_000);
      expect(await store.del(['a', 'missing'])).toBe(1);
      expect(await store.del(['a', 'missing'])).toBe(0);
      expect(await store.del([])).toBe(0);
    });

    it('拒绝非正数 TTL（禁止无过期写入）', async () => {
      const store = createStore();
      await expect(store.set('bad-zero', 'x', 0)).rejects.toThrow();
      await expect(store.set('bad-negative', 'x', -1)).rejects.toThrow();
      await expect(store.sadd('bad-tag', ['m'], 0)).rejects.toThrow();
      await expect(store.compareAndExpire('k', 'v', 0)).rejects.toThrow();
    });

    it('集合成员去重且可重复读取；smembers 缺失键返回空数组', async () => {
      const store = createStore();
      await store.sadd('tag', ['a', 'b', 'a'], 10_000);
      expect((await store.smembers('tag')).sort()).toEqual(['a', 'b']);
      expect((await store.smembers('tag')).sort()).toEqual(['a', 'b']);
      expect(await store.smembers('absent')).toEqual([]);
    });

    it('sadd(key, [], ttl) 为无操作，不创建幽灵集合', async () => {
      const store = createStore();
      await store.sadd('empty-tag', [], 10_000);
      expect(await store.smembers('empty-tag')).toEqual([]);
      expect(await store.exists('empty-tag')).toBe(false);
    });

    it('TTL 过期后 get / exists / smembers 结果一致（惰性过期）', async () => {
      const store = createStore();
      await store.set('v-key', 'V', 30);
      await store.sadd('s-key', ['m'], 30);
      await sleep(50);
      expect(await store.get('v-key')).toBeUndefined();
      expect(await store.exists('v-key')).toBe(false);
      expect(await store.smembers('s-key')).toEqual([]);
      expect(await store.exists('s-key')).toBe(false);
    });

    // ---------- A-01：类型冲突显式失败（对齐 Redis WRONGTYPE），原数据不被静默覆盖 ----------

    it('同一键不能同时作为 value 和 set 使用：sadd 遇字符串键抛错且原值保留', async () => {
      const store = createStore();
      await store.set('shared-key', 'original', 10_000);
      await expect(store.sadd('shared-key', ['member'], 10_000)).rejects.toThrow(/WRONGTYPE|类型冲突/);
      expect(await store.get('shared-key')).toBe('original');
    });

    it('get / smembers 遇不符类型抛错；mget 对集合键返回 undefined（对齐 MGET nil）', async () => {
      const store = createStore();
      await store.sadd('set-key', ['m'], 10_000);
      await store.set('str-key', 'S', 10_000);
      await expect(store.get('set-key')).rejects.toThrow(/WRONGTYPE|类型冲突/);
      await expect(store.smembers('str-key')).rejects.toThrow(/WRONGTYPE|类型冲突/);
      // mget 永不出错（Redis MGET 对非字符串返回 nil）
      expect((await store.mget(['set-key', 'str-key']))[0]).toBeUndefined();
      expect((await store.mget(['set-key', 'str-key']))[1]).toBe('S');
    });

    it('compareAndDelete / compareAndExpire 对集合键抛错（Lua 内 GET 的 WRONGTYPE）', async () => {
      const store = createStore();
      await store.sadd('lock-as-set', ['m'], 10_000);
      await expect(store.compareAndDelete('lock-as-set', 't')).rejects.toThrow(/WRONGTYPE|类型冲突/);
      await expect(store.compareAndExpire('lock-as-set', 't', 5000)).rejects.toThrow(/WRONGTYPE|类型冲突/);
    });

    it('set 覆盖任意类型（对齐 Redis SET）、del / exists / expire 任意类型可用', async () => {
      const store = createStore();
      await store.sadd('poly', ['m'], 10_000);
      await store.set('poly', 'now-string', 10_000);
      expect(await store.get('poly')).toBe('now-string');
      await store.sadd('poly2', ['m'], 10_000);
      expect(await store.exists('poly2')).toBe(true);
      expect(await store.expire('poly2', 10_000)).toBe(true);
      expect(await store.del(['poly2'])).toBe(1);
    });

    it('条件操作令牌语义：不匹配失败、匹配成功（锁安全释放/续期基础）', async () => {
      const store = createStore();
      await store.set('lock', 'token-a', 10_000);
      expect(await store.compareAndDelete('lock', 'token-x')).toBe(false);
      expect(await store.compareAndExpire('lock', 'token-x', 10_000)).toBe(false);
      expect(await store.compareAndExpire('lock', 'token-a', 10_000)).toBe(true);
      expect(await store.compareAndDelete('lock', 'token-a')).toBe(true);
    });

    // ---------- C-01/C-03/A-04：原子标签方法（两驱动同契约） ----------

    it('setWithTags 原子写值+登记；invalidateByTag 删除成员与索引并返回数量', async () => {
      const store = createStore();
      await store.setWithTags('k1', 'v1', 10_000, [
        { tagKey: 'tag', ttlMs: 60_000 },
        { tagKey: 'tag2', ttlMs: 60_000 },
      ]);
      await store.setWithTags('k2', 'v2', 10_000, [{ tagKey: 'tag', ttlMs: 60_000 }]);
      await store.set('keep', 'V', 10_000);
      expect(await store.get('k1')).toBe('v1');
      expect((await store.smembers('tag')).sort()).toEqual(['k1', 'k2']);
      expect(await store.smembers('tag2')).toEqual(['k1']);
      expect(await store.invalidateByTag('tag')).toBe(2);
      expect(await store.get('k1')).toBeUndefined();
      expect(await store.get('k2')).toBeUndefined();
      expect(await store.smembers('tag')).toEqual([]);
      expect(await store.get('keep')).toBe('V');
      // 索引已删：再次失效返回 0
      expect(await store.invalidateByTag('tag')).toBe(0);
      // tag2 未受影响
      expect(await store.smembers('tag2')).toEqual(['k1']);
    });

    it('invalidateByTag 返回实际删除数：幽灵索引（成员指向已删键）计 0，索引仍被清理', async () => {
      const store = createStore();
      await store.setWithTags('ghost', 'v', 10_000, [{ tagKey: 'gtag', ttlMs: 60_000 }]);
      // 绕过缓存层直接删值键，制造「索引成员指向不存在键」的残留（P1 加固后唯一允许的残余方向）
      expect(await store.del(['ghost'])).toBe(1);
      expect(await store.smembers('gtag')).toEqual(['ghost']);
      expect(await store.invalidateByTag('gtag')).toBe(0);
      expect(await store.exists('gtag')).toBe(false);
    });

    // ---------- P1 复核（2026-10-18）：setWithTags 写前预检，确定性错误零写入 ----------

    it('setWithTags 遇标签键类型冲突：预检失败且值键 / 其余标签键零写入（不留孤儿缓存）', async () => {
      const store = createStore();
      // 类型污染：标签索引键被占成字符串（应失败而非静默替换）
      await store.set('occupied-tag', 'original', 10_000);
      await expect(
        store.setWithTags('k', 'v', 10_000, [
          { tagKey: 'good-tag', ttlMs: 60_000 },
          { tagKey: 'occupied-tag', ttlMs: 60_000 },
        ]),
      ).rejects.toThrow(/WRONGTYPE|类型冲突/);
      expect(await store.get('k')).toBeUndefined();
      expect(await store.smembers('good-tag')).toEqual([]);
      expect(await store.exists('good-tag')).toBe(false);
      expect(await store.get('occupied-tag')).toBe('original');
    });

    it('setWithTags 遇标签键与值键同名：拒绝写入（配置错误，不产生半程状态）', async () => {
      const store = createStore();
      await expect(store.setWithTags('self-tag', 'v', 10_000, [{ tagKey: 'self-tag', ttlMs: 60_000 }])).rejects.toThrow(
        /标签键与值键相同/,
      );
      expect(await store.exists('self-tag')).toBe(false);
    });
  });
}

storeContract('memory', () => new MemoryCacheStore());
storeContract('redis(fake)', () => new RedisCacheStore(new FakeRedisClient()));

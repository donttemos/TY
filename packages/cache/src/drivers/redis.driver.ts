/*
 * @file redis / redis-cluster 缓存驱动
 * @description 基于 ioredis 的存储端口实现：字符串用 SET PX / GET / MGET，集合用 SADD/SMEMBERS，
 *   条件删除与条件续期用 Lua 保证原子（锁的安全释放与续期，PRD-004 FR-09）。
 *   本文件不 import ioredis，只依赖 RedisClientLike 接口，便于用 fake 客户端跑单测（TC-CACHE-001）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import type { CacheStorePort } from '../store.port.js';
import type { CacheDriverName } from '../types.js';
import type { RedisClientLike } from './redis-client.js';

/** 条件删除脚本：值匹配才删除（锁释放） */
const COMPARE_DELETE_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** 条件续期脚本：值匹配才续期（锁续期） */
const COMPARE_EXPIRE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

/**
 * Redis 存储驱动（同时服务 `redis` 与 `redis-cluster` 两种模式）
 */
export class RedisCacheStore implements CacheStorePort {
  /**
   * @param client 已连接的 ioredis 客户端
   * @param kind 驱动名（redis / redis-cluster，仅用于指标与日志区分）
   */
  constructor(
    private readonly client: RedisClientLike,
    readonly kind: CacheDriverName = 'redis',
  ) {}

  async get(key: string): Promise<string | undefined> {
    const raw = await this.client.get(key);
    return raw === null ? undefined : raw;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.assertTtl(ttlMs);
    await this.client.set(key, value, 'PX', Math.round(ttlMs));
  }

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.assertTtl(ttlMs);
    const result = await this.client.set(key, value, 'PX', Math.round(ttlMs), 'NX');
    return result === 'OK';
  }

  async del(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    this.assertTtl(ttlMs);
    return (await this.client.pexpire(key, Math.round(ttlMs))) === 1;
  }

  async mget(keys: readonly string[]): Promise<Array<string | undefined>> {
    if (keys.length === 0) return [];
    const values = await this.client.mget(...keys);
    return values.map((value) => (value === null ? undefined : value));
  }

  async sadd(key: string, members: readonly string[], ttlMs: number): Promise<void> {
    this.assertTtl(ttlMs);
    if (members.length === 0) return;
    await this.client.sadd(key, ...members);
    // 每次登记刷新集合 TTL：映射比业务键活得久，避免「幽灵缓存」（PRD-004 §8）
    await this.client.pexpire(key, Math.round(ttlMs));
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    const result = await this.client.eval(COMPARE_DELETE_LUA, 1, key, expected);
    return Number(result) === 1;
  }

  async compareAndExpire(key: string, expected: string, ttlMs: number): Promise<boolean> {
    this.assertTtl(ttlMs);
    const result = await this.client.eval(COMPARE_EXPIRE_LUA, 1, key, expected, Math.round(ttlMs));
    return Number(result) === 1;
  }

  async ping(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // quit 在断连场景会抛错，兜底强制断开，保证优雅停机不被缓存阻塞
      this.client.disconnect();
    }
  }

  async size(): Promise<number> {
    // 说明：dbsize 为整库键数（无法按前缀过滤），此处作为容量观测的近似值
    return this.client.dbsize();
  }

  /** 校验 TTL：禁止无过期写入 */
  private assertTtl(ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`缓存 TTL 必须为正数（毫秒）：收到 ${ttlMs}；禁止无过期时间的缓存`);
    }
  }
}

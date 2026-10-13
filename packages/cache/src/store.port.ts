/*
 * @file 缓存存储端口（CacheStorePort）
 * @description 框架自有的最底层 KV 抽象：只暴露字符串读写、TTL、集合（标签映射）与条件操作。
 *   memory 与 redis 两种驱动实现同一端口，CacheService 只依赖本端口，
 *   因此切换驱动时业务与服务层 diff = 0（PRD-004 FR-02 / AC-002）。
 *   本文件不得出现任何驱动特有类型（ioredis / Redis 类型）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import type { CacheDriverName } from './types.js';

/**
 * 存储端口：全部方法均为 Promise（memory 同步实现也返回 Promise，保证行为一致）
 *
 * 约定：
 * - TTL 一律以**毫秒**传递，且必须为正数（禁止无过期写入）；
 * - `del` 幂等，返回实际删除数量；
 * - 条件操作（`compareAndDelete` / `compareAndExpire`）用于锁的安全释放与续期，
 *   redis 驱动用 Lua 保证原子，memory 驱动用单线程语义保证。
 */
export interface CacheStorePort {
  /** 驱动名 */
  readonly kind: CacheDriverName;
  /** 读取：不存在或已过期返回 undefined */
  get(key: string): Promise<string | undefined>;
  /** 写入并设置 TTL */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** 仅当键不存在时写入，返回是否写入成功（锁获取用） */
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** 删除（幂等），返回删除数量 */
  del(keys: readonly string[]): Promise<number>;
  /** 是否存在有效键 */
  exists(key: string): Promise<boolean>;
  /** 重设 TTL，键不存在返回 false */
  expire(key: string, ttlMs: number): Promise<boolean>;
  /** 批量读取，顺序与入参一致 */
  mget(keys: readonly string[]): Promise<Array<string | undefined>>;
  /** 集合写入（标签映射）：成员去重并续期整个集合的 TTL */
  sadd(key: string, members: readonly string[], ttlMs: number): Promise<void>;
  /** 集合读取 */
  smembers(key: string): Promise<string[]>;
  /** 值等于期望值时才删除（锁安全释放），返回是否删除 */
  compareAndDelete(key: string, expected: string): Promise<boolean>;
  /** 值等于期望值时才续期（锁续期），返回是否续期 */
  compareAndExpire(key: string, expected: string, ttlMs: number): Promise<boolean>;
  /** 可用性探测 */
  ping(): Promise<boolean>;
  /** 释放连接（优雅停机） */
  close(): Promise<void>;
  /** 当前有效键数量（观测用；redis 驱动返回本地计数近似值） */
  size(): Promise<number>;
}

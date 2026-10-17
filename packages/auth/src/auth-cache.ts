/*
 * @file 鉴权缓存端口与内存实现
 * @description PRD-003 依赖 PRD-004 的 CacheService 做权限缓存与令牌黑名单；M4 尚未落地，
 *   因此此处先冻结 L2 需要的最小端口（get/set/del/invalidateTag），并给出内存实现作为
 *   stub（对齐 85 文档 §4「stub 策略：L3 未就绪时走内存实现」）。
 *   M4 接入时只需在 AuthModule 注入 CacheService 适配器，业务代码零改动。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-02）：裸抛迁移至 BizError 统一码（ADR-0025 三类治理）
 * @module @fw/auth
 */

import { BizError, ErrorCode } from '@fw/core';

/** 鉴权缓存端口（对齐 docs/contracts/cache.ts 的 C-04 子集） */
export interface AuthCachePort {
  /** 读取，未命中或已过期返回 undefined */
  get<T>(key: string): Promise<T | undefined>;
  /** 写入；ttlSeconds 必须为正（禁止无 TTL 缓存） */
  set(key: string, value: unknown, ttlSeconds: number, tags?: string[]): Promise<void>;
  /** 删除单个键 */
  del(key: string): Promise<void>;
  /** 按标签批量失效（权限变更时按 `user:<id>` 失效） */
  invalidateTag(tag: string): Promise<void>;
}

/** 缓存条目 */
interface Entry {
  value: unknown;
  /** 过期时间戳（毫秒） */
  expireAt: number;
}

/**
 * 内存缓存实现（进程内单例；多实例部署下不共享，故仅作 M4 前的兜底）
 *
 * 行为约定：
 * - TTL 到期即视为不存在（惰性淘汰 + 写入时抽样清理）
 * - 标签映射独立存储，`invalidateTag` 删除该标签下全部键
 */
export class MemoryAuthCache implements AuthCachePort {
  private readonly store = new Map<string, Entry>();
  private readonly tags = new Map<string, Set<string>>();

  /** 清理阈值：store 超过该值且存在过期键时触发一次抽样清理 */
  private static readonly SWEEP_THRESHOLD = 1000;

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expireAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number, tags: string[] = []): Promise<void> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `缓存 TTL 必须为正数（key=${key}）：禁止无过期时间的缓存`);
    }
    this.store.set(key, { value, expireAt: Date.now() + ttlSeconds * 1000 });
    for (const tag of tags) {
      const bucket = this.tags.get(tag) ?? new Set<string>();
      bucket.add(key);
      this.tags.set(tag, bucket);
    }
    if (this.store.size > MemoryAuthCache.SWEEP_THRESHOLD) this.sweep();
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
    for (const bucket of this.tags.values()) bucket.delete(key);
  }

  async invalidateTag(tag: string): Promise<void> {
    const bucket = this.tags.get(tag);
    if (!bucket) return;
    for (const key of bucket) this.store.delete(key);
    this.tags.delete(tag);
  }

  /** 当前键数量（测试与观测用） */
  size(): number {
    return this.store.size;
  }

  /** 删除过期键与空标签桶 */
  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expireAt <= now) this.store.delete(key);
    }
    for (const [tag, bucket] of this.tags) {
      for (const key of bucket) {
        if (!this.store.has(key)) bucket.delete(key);
      }
      if (bucket.size === 0) this.tags.delete(tag);
    }
  }
}

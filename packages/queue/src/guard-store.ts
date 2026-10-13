/*
 * @file 执行守卫存储（幂等标记 + 分布式锁）
 * @description 队列的两处跨实例协调都落在本端口上：
 *   ① 幂等标记：`idempotencyKey` 成功执行后置位，窗口期内重复 dispatch 直接跳过（PRD-007 FR-05）；
 *   ② cron 互斥锁：集群内同一触发时刻只允许一个实例执行（PRD-007 FR-03 / TC-JOB-002）。
 *   默认实现复用 @fw/cache 的 CacheService（redis 驱动时天然分布式）；
 *   未接入缓存时退化为进程内实现，`distributed=false` 供启动期告警使用——memory 驱动
 *   只适用于单实例或可重复执行的定时任务（PRD-007 §8 风险说明）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import type { CacheService } from '@fw/cache';
import type { LockHandle } from '@fw/cache';

/** 守卫锁句柄 */
export interface GuardLockHandle {
  /** 释放锁 */
  release(): Promise<boolean>;
}

/** 执行守卫存储端口 */
export interface QueueGuardStore {
  /** 是否为真实分布式（false = 进程内，多副本下不互斥） */
  readonly distributed: boolean;
  /**
   * 幂等标记是否存在
   * @param key 幂等键
   */
  hasMarker(key: string): Promise<boolean>;
  /**
   * 写入幂等标记
   * @param key 幂等键
   * @param ttlSeconds 窗口期（秒）
   */
  markDone(key: string, ttlSeconds: number): Promise<void>;
  /**
   * 获取互斥锁
   * @param key 锁键
   * @param ttlSeconds TTL（秒）
   * @returns 锁句柄；未获取到返回 null
   */
  acquireLock(key: string, ttlSeconds: number): Promise<GuardLockHandle | null>;
  /** 可用性探测 */
  ping(): Promise<boolean>;
}

/**
 * 进程内实现：memory 驱动与单元测试用；多副本下不互斥（`distributed=false`）
 */
export class MemoryGuardStore implements QueueGuardStore {
  readonly distributed = false;

  /** 幂等标记：键 → 过期时刻（毫秒） */
  private readonly markers = new Map<string, number>();

  /** 互斥锁：键 → 过期时刻（毫秒） */
  private readonly locks = new Map<string, number>();

  /**
   * @param now 时钟（测试可注入）
   */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** @inheritdoc */
  async hasMarker(key: string): Promise<boolean> {
    const expiresAt = this.markers.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.markers.delete(key);
      return false;
    }
    return true;
  }

  /** @inheritdoc */
  async markDone(key: string, ttlSeconds: number): Promise<void> {
    this.markers.set(key, this.now() + ttlSeconds * 1000);
  }

  /** @inheritdoc */
  async acquireLock(key: string, ttlSeconds: number): Promise<GuardLockHandle | null> {
    const expiresAt = this.locks.get(key);
    if (expiresAt !== undefined && expiresAt > this.now()) return null;
    this.locks.set(key, this.now() + ttlSeconds * 1000);
    return {
      release: async () => {
        const current = this.locks.get(key);
        if (current !== undefined && current > this.now()) {
          this.locks.delete(key);
          return true;
        }
        return false;
      },
    };
  }

  /** @inheritdoc */
  async ping(): Promise<boolean> {
    return true;
  }

  /** 清空全部状态（测试用） */
  reset(): void {
    this.markers.clear();
    this.locks.clear();
  }
}

/**
 * 缓存实现：复用 CacheService（redis 驱动时跨实例互斥）
 */
export class CacheGuardStore implements QueueGuardStore {
  /** @inheritdoc */
  get distributed(): boolean {
    return this.cache.driver !== 'memory';
  }

  /**
   * @param cache 缓存服务（由 @fw/cache 提供）
   * @param prefix 键前缀（区分队列标记与业务缓存）
   */
  constructor(
    private readonly cache: CacheService,
    private readonly prefix = 'fw:queue',
  ) {}

  /** @inheritdoc */
  async hasMarker(key: string): Promise<boolean> {
    return (await this.cache.get<string>(`${this.prefix}:idem:${key}`)) !== undefined;
  }

  /** @inheritdoc */
  async markDone(key: string, ttlSeconds: number): Promise<void> {
    await this.cache.set(`${this.prefix}:idem:${key}`, 'done', { ttlSeconds });
  }

  /** @inheritdoc */
  async acquireLock(key: string, ttlSeconds: number): Promise<GuardLockHandle | null> {
    const handle: LockHandle | null = await this.cache.lock(`${this.prefix}:lock:${key}`, ttlSeconds, { autoRenew: true });
    return handle ? { release: () => handle.release() } : null;
  }

  /** @inheritdoc */
  async ping(): Promise<boolean> {
    return this.cache.ping();
  }
}

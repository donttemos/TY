/*
 * @file 分布式锁（Lock API）
 * @description 基于存储端口的 `SET NX PX` 语义实现互斥：redis 驱动用 Lua 做令牌校验的释放与续期，
 *   memory 驱动退化为进程内锁（多实例下不互斥，仅适用于单实例定时任务，PRD-004 §8 风险说明）。
 *   支持自动续期（看门狗，TTL/3 周期）与可重入标记（同一持有者重复获取只加深度）。
 *   释放时校验令牌，避免「误删他人锁」（长任务超越 TTL 后由新持有者持锁的场景）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo M9/PRD-009 FR-09：默认 TTL 可变（updateDefaultTtl）——cache.lockTtl 配置中心热更的生效路径
 * @module @fw/cache
 */

import { randomUUID } from 'node:crypto';
import { Logger } from '@fw/logger';
import type { CacheStorePort } from './store.port.js';

const logger = Logger.for('cache.lock');

/** 锁句柄（与 C-04 契约 LockHandle 同源） */
export interface LockHandle {
  /** 完整锁键 */
  readonly key: string;
  /** 持有者令牌 */
  readonly token: string;
  /** 当前 TTL（毫秒） */
  readonly ttlMs: number;
  /** 是否重入获取 */
  readonly reentrant: boolean;
  /** 释放（重入时只减深度）；返回是否真正释放 */
  release(): Promise<boolean>;
  /** 续期；返回是否成功 */
  renew(ttlMs?: number): Promise<boolean>;
}

/** 获取锁选项（与 C-04 契约 LockOptions 同源） */
export interface LockOptions {
  /** 允许同持有者重入 */
  reentrant?: boolean;
  /** 自动续期（看门狗） */
  autoRenew?: boolean;
  /** 持有者标识（跨实例需显式传入业务唯一标识） */
  owner?: string;
  /** 等待获取的最大毫秒数（默认 0：不等待） */
  waitMs?: number;
}

/** 进程内持有记录（重入深度） */
interface HeldRecord {
  token: string;
  depth: number;
}

/** 轮询间隔上限（等待获取锁时） */
const WAIT_POLL_MS = 50;

/**
 * 锁管理器：由 CacheService 内部持有（同一 store 对应一个实例）
 */
export class LockManager {
  /** 本进程默认持有者标识 */
  private readonly ownerId = randomUUID();

  /** 本进程持有的锁（键 → 令牌与重入深度） */
  private readonly held = new Map<string, HeldRecord>();

  /**
   * @param store 存储端口
   * @param defaultTtlMs 默认 TTL（毫秒）
   */
  constructor(
    private readonly store: CacheStorePort,
    private defaultTtlMs: number,
  ) {}

  /**
   * 更新默认 TTL（毫秒）（M9/PRD-009：配置中心热更 cache.lockTtl 的生效路径；对新获取的锁生效）
   * @param defaultTtlMs 新默认 TTL（毫秒）
   */
  updateDefaultTtl(defaultTtlMs: number): void {
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * 获取锁
   * @param key 完整锁键
   * @param ttlMs TTL（毫秒），缺省用默认值
   * @param options 重入 / 续期 / 持有者 / 等待
   * @returns 锁句柄；未获取到返回 null
   */
  async acquire(key: string, ttlMs: number = this.defaultTtlMs, options: LockOptions = {}): Promise<LockHandle | null> {
    const deadline = Date.now() + (options.waitMs ?? 0);
    for (;;) {
      // 可重入分支：本进程已持有同一把锁且令牌一致 → 深度 +1
      if (options.reentrant) {
        const local = this.held.get(key);
        if (local && (await this.store.get(key)) === local.token) {
          local.depth++;
          logger.debug('锁重入', { key, depth: local.depth });
          return this.createHandle(key, local.token, ttlMs, true, options.autoRenew === true);
        }
      }

      const token = `${options.owner ?? this.ownerId}:${randomUUID()}`;
      if (await this.store.setNx(key, token, ttlMs)) {
        this.held.set(key, { token, depth: 1 });
        logger.debug('获取锁成功', { key, ttlMs });
        return this.createHandle(key, token, ttlMs, false, options.autoRenew === true);
      }

      if (Date.now() >= deadline) {
        logger.debug('获取锁失败（超时）', { key });
        return null;
      }
      await sleep(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  /** 构造句柄：绑定释放与续期语义 */
  private createHandle(key: string, token: string, ttlMs: number, reentrant: boolean, autoRenew: boolean): LockHandle {
    let watchdog: NodeJS.Timeout | undefined;
    const stopWatchdog = (): void => {
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = undefined;
      }
    };

    const handle: LockHandle = {
      key,
      token,
      ttlMs,
      reentrant,
      release: async (): Promise<boolean> => {
        stopWatchdog();
        const local = this.held.get(key);
        if (reentrant && local && local.token === token && local.depth > 1) {
          local.depth--;
          return true;
        }
        this.held.delete(key);
        return this.store.compareAndDelete(key, token);
      },
      renew: async (ms?: number): Promise<boolean> => this.store.compareAndExpire(key, token, ms ?? ttlMs),
    };

    if (autoRenew) {
      // 看门狗周期为 TTL/3，保证至少两次续期机会；unref 避免阻塞进程退出
      const interval = Math.max(1000, Math.floor(ttlMs / 3));
      watchdog = setInterval(() => {
        void handle.renew().then(
          (ok) => {
            if (!ok) {
              stopWatchdog();
              logger.warn('锁续期失败（已失去锁）', { key });
            }
          },
          (error: unknown) => {
            stopWatchdog();
            logger.warn('锁续期异常（已停止看门狗）', { key, error: error instanceof Error ? error.message : String(error) });
          },
        );
      }, interval);
      watchdog.unref?.();
    }

    return handle;
  }
}

/** 可中断的等待 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

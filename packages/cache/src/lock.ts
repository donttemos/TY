/*
 * @file 分布式锁（Lock API）
 * @description 基于存储端口的 `SET NX PX` 语义实现互斥：redis 驱动用 Lua 做令牌校验的释放与续期，
 *   memory 驱动退化为进程内锁（多实例下不互斥，仅适用于单实例定时任务，PRD-004 §8 风险说明）。
 *   支持自动续期（看门狗，TTL/3 周期）与可重入标记（同一持有者重复获取只加深度）。
 *   释放时校验令牌，避免「误删他人锁」（长任务超越 TTL 后由新持有者持锁的场景）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo M9/PRD-009 FR-09：默认 TTL 可变（updateDefaultTtl）——cache.lockTtl 配置中心热更的生效路径
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复：① C-02 释放语义改由**共享持有记录的深度**
 *   决定（原实现按句柄创建时的 reentrant 布尔值判断，普通获取句柄先释放会连重入方一起释放整把锁），
 *   并明确 release 幂等（重复释放返回 false，不再二次触碰存储）；② C-04 看门狗周期改为与 TTL 成比例
 *   （`max(50ms, TTL/3)`，短 TTL 不再晚于过期才续期）并在 TTL<1s 时告警；新增 `onLost` 回调——
 *   续期失败/异常停表后调用方可在锁已被他人取得时感知失锁（原实现仅日志，调用方无感知）。
 * @modified 2026-10-18 donttemo 复核修复（P2）：`acquire()` 入口统一校验 `ttlMs` 与 `waitMs`——
 *   本地重入分支不写存储、此前绕过了驱动侧 TTL 校验（非法 TTL 在重入路径静默成功），
 *   同一 API 参数不再因「是否重入」而行为不同；校验先于深度变更，失败不留半程状态。
 * @module @fw/cache
 */

import { randomUUID } from 'node:crypto';
import { BizError, ErrorCode } from '@fw/core';
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
  /**
   * 释放；返回是否真正释放。
   * 语义（C-02 修复）：释放行为由**共享持有记录的深度**决定——深度 > 1 时只减深度（无论本句柄
   * 是普通获取还是重入获取），深度 = 1 时删除本地记录并做令牌校验删除；重复释放幂等返回 false。
   */
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
  /**
   * 失锁感知回调（C-04）：`autoRenew` 开启时，看门狗续期失败（锁已被他人取得或已过期）或
   * 续期调用自身异常后停表，并触发本回调一次。持锁副作用不可重复的业务应据此中止执行。
   */
  onLost?: (reason: 'renew-failed' | 'renew-error') => void;
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
   * @throws BizError ttlMs 非正数 / waitMs 非法（CONFIG_INVALID_VALUE，重入与普通获取一致）
   */
  async acquire(key: string, ttlMs: number = this.defaultTtlMs, options: LockOptions = {}): Promise<LockHandle | null> {
    // 参数校验统一放在入口（2026-10-18 复核）：本地重入分支不写存储、因而不会触发驱动侧的 TTL
    // 校验——若只在「真正 SET NX」的路径校验，同一个非法 ttlMs/waitMs 会因「是否重入」表现不同
    // （重入静默成功并生成句柄，普通获取抛错）。校验先于一切状态变更，失败不改变重入深度。
    assertLockTtl(ttlMs);
    const waitMs = options.waitMs ?? 0;
    assertLockWaitMs(waitMs);
    const deadline = Date.now() + waitMs;
    for (;;) {
      // 可重入分支：本进程已持有同一把锁且令牌一致 → 深度 +1
      if (options.reentrant) {
        const local = this.held.get(key);
        if (local && (await this.store.get(key)) === local.token) {
          local.depth++;
          logger.debug('锁重入', { key, depth: local.depth });
          return this.createHandle(key, local.token, ttlMs, true, options);
        }
      }

      const token = `${options.owner ?? this.ownerId}:${randomUUID()}`;
      if (await this.store.setNx(key, token, ttlMs)) {
        this.held.set(key, { token, depth: 1 });
        logger.debug('获取锁成功', { key, ttlMs });
        return this.createHandle(key, token, ttlMs, false, options);
      }

      if (Date.now() >= deadline) {
        logger.debug('获取锁失败（超时）', { key });
        return null;
      }
      await sleep(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  /** 构造句柄：绑定释放与续期语义（释放以共享持有记录为准，C-02） */
  private createHandle(key: string, token: string, ttlMs: number, reentrant: boolean, options: LockOptions): LockHandle {
    let watchdog: NodeJS.Timeout | undefined;
    const stopWatchdog = (): void => {
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = undefined;
      }
    };

    /** 幂等保护：一个句柄只允许参与一次释放（重复 release 直接 false，不再触碰共享状态与存储） */
    let released = false;

    const handle: LockHandle = {
      key,
      token,
      ttlMs,
      reentrant,
      release: async (): Promise<boolean> => {
        if (released) return false;
        released = true;
        stopWatchdog();
        const local = this.held.get(key);
        // 释放语义由共享持有记录决定：深度 > 1 只减深度，与「本句柄当初怎么获取」无关（C-02 修复点）
        if (local && local.token === token) {
          if (local.depth > 1) {
            local.depth--;
            return true;
          }
          this.held.delete(key);
        }
        // 本地无匹配记录（跨管理器实例 / TTL 过期后被他人取得）：仍做令牌校验删除，防误删他人锁
        return this.store.compareAndDelete(key, token);
      },
      renew: async (ms?: number): Promise<boolean> => this.store.compareAndExpire(key, token, ms ?? ttlMs),
    };

    if (options.autoRenew === true) {
      // 看门狗周期与 TTL 成比例（TTL/3），下限 50ms 仅覆盖定时器粒度（C-04 修复点：
      // 原实现 max(1000, TTL/3) 在 TTL < 1000ms 时首次续期晚于锁过期，autoRenew 形同虚设）
      const interval = Math.max(50, Math.floor(ttlMs / 3));
      if (ttlMs < 1000) {
        logger.warn('锁 TTL 过短：自动续期依赖存储往返及时完成，短 TTL 下失锁窗口不可忽略', { key, ttlMs, intervalMs: interval });
      }
      watchdog = setInterval(() => {
        void handle.renew().then(
          (ok) => {
            if (!ok) {
              stopWatchdog();
              logger.warn('锁续期失败（已失去锁）', { key });
              options.onLost?.('renew-failed');
            }
          },
          (error: unknown) => {
            stopWatchdog();
            logger.warn('锁续期异常（已停止看门狗）', { key, error: error instanceof Error ? error.message : String(error) });
            options.onLost?.('renew-error');
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

/**
 * 锁 TTL 校验（毫秒）：与存储端口同口径（禁止无过期写入），非法值 fail-fast。
 * 放在 acquire 入口而非只依赖驱动，保证「重入 / 普通获取」两条路径对同一参数行为一致。
 */
function assertLockTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `锁 TTL 必须为正数（毫秒）：收到 ${ttlMs}；禁止无过期时间的锁`);
  }
}

/**
 * 锁等待参数校验（毫秒）：`waitMs` 必须为 ≥0 的有限数值。
 * 导出给 `CacheService.lock` 复用——调用级参数非法必须 fail-fast，不能被 fail-open 降级成 null。
 * @param waitMs 等待毫秒数
 */
export function assertLockWaitMs(waitMs: number): void {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `锁 waitMs 必须为 ≥0 的有限数值（毫秒）：收到 ${waitMs}`);
  }
}

/*
 * @file CacheService：统一缓存服务（框架唯一对外缓存入口）
 * @description 在存储端口之上实现 PRD-004 全部能力：统一接口（get/set/del/has/wrap/mget/mset/expire/
 *   invalidateTag）、全局 key 前缀、JSON 信封（区分空值占位）、标签化失效、三大防护
 *   （防穿透=空值占位、防击穿=进程内单飞、防雪崩=TTL 抖动）、大 key 防护、故障降级
 *   （CACHE_FAIL_OPEN）与指标采集。业务代码只依赖本类，切换驱动零改动（AC-002）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { Logger } from '@fw/logger';
import { CacheUnavailableError } from './errors.js';
import { assertLogicalKey, decodeEntry, encodeNegative, encodeValue, tagKeyOf, withPrefix } from './key.js';
import { LockManager, type LockHandle, type LockOptions } from './lock.js';
import { CacheMetrics } from './metrics.js';
import { withCacheSpan } from './trace.js';
import type { CacheStorePort } from './store.port.js';
import type { CacheCallOptions, CacheDriverName, CacheMetricsSnapshot, CacheReadResult, CacheRuntimeOptions } from './types.js';

const logger = Logger.for('cache');

/** 构造参数 */
export interface CacheServiceDeps {
  /** 存储端口（memory / redis） */
  store: CacheStorePort;
  /** 运行时配置 */
  options: CacheRuntimeOptions;
  /** 指标采集器（缺省自建，测试可注入共享实例） */
  metrics?: CacheMetrics;
}

/** 单飞表项（key → 进行中的回源 Promise） */
type Inflight = Promise<unknown>;

/**
 * 统一缓存服务
 *
 * 语义要点（与 docs/contracts/cache.ts C-04 一致）：
 * - `get` 对未命中与空值占位均返回 undefined；
 * - 存储故障时按 `CACHE_FAIL_OPEN` 降级（读→未命中，写→忽略，锁→null）并计降级指标；
 *   `false` 时抛 `CacheUnavailableError`（9002 / 503）；
 * - 大 key（序列化后超 `CACHE_MAX_VALUE_BYTES`）拒绝写入并告警，不抛异常。
 */
export class CacheService {
  private readonly store: CacheStorePort;
  private readonly opt: CacheRuntimeOptions;
  private readonly metrics: CacheMetrics;
  private readonly inflight = new Map<string, Inflight>();
  private readonly lockManager: LockManager;

  /**
   * @param deps 存储端口、运行时配置与可选指标采集器
   */
  constructor(deps: CacheServiceDeps) {
    this.store = deps.store;
    this.opt = deps.options;
    this.metrics = deps.metrics ?? new CacheMetrics();
    this.lockManager = new LockManager(this.store, this.opt.lockTtlSeconds * 1000);
  }

  /** 当前驱动名 */
  get driver(): CacheDriverName {
    return this.store.kind;
  }

  /** 全局前缀（已解析） */
  get prefix(): string {
    return this.opt.prefix;
  }

  /**
   * 业务逻辑键 → 完整键（补全局前缀 + 白名单校验）
   * @param key 逻辑键
   */
  resolveKey(key: string): string {
    assertLogicalKey(key);
    return withPrefix(this.opt.prefix, key);
  }

  /**
   * 读取（未命中与空值占位均返回 undefined）
   * @param key 逻辑键
   * @param options 覆盖选项
   */
  async get<T>(key: string, options?: CacheCallOptions): Promise<T | undefined> {
    const result = await this.read<T>(key, options);
    return result.value;
  }

  /**
   * 读取（含命中类型，供三防护与观测使用）
   * @param key 逻辑键
   * @param options 覆盖选项
   */
  async read<T>(key: string, options?: CacheCallOptions): Promise<CacheReadResult<T>> {
    return this.readRaw<T>(this.resolveKey(key), options);
  }

  /**
   * 写入；`value` 为 null/undefined 时写空值占位（防穿透）
   * @param key 逻辑键
   * @param value 业务值
   * @param options 覆盖选项
   */
  async set(key: string, value: unknown, options?: CacheCallOptions): Promise<void> {
    await this.setRaw(this.resolveKey(key), value, options);
  }

  /**
   * 批量写入
   * @param entries 键值（可带独立标签）
   * @param options 公共覆盖选项
   */
  async mset(entries: ReadonlyArray<{ key: string; value: unknown; tags?: string[] }>, options?: CacheCallOptions): Promise<void> {
    for (const entry of entries) {
      await this.setRaw(this.resolveKey(entry.key), entry.value, { ...options, tags: entry.tags ?? options?.tags });
    }
  }

  /**
   * 批量读取；未命中键不出现在返回 Map 中
   * @param keys 逻辑键数组
   * @param options 覆盖选项
   */
  async mget<T>(keys: readonly string[], options?: CacheCallOptions): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const fullKeys = keys.map((key) => this.resolveKey(key));
    const raws = await this.guarded('mget', { count: fullKeys.length }, options, () => this.store.mget(fullKeys), () => [] as Array<string | undefined>);
    raws.forEach((raw, index) => {
      if (raw === undefined) {
        this.metrics.miss();
        return;
      }
      const decoded = decodeEntry<T>(raw);
      this.metrics.hit();
      if (decoded.kind === 'positive' && decoded.value !== undefined) out.set(keys[index], decoded.value);
    });
    return out;
  }

  /**
   * 删除（幂等）
   * @param keys 逻辑键或键数组
   */
  async del(keys: string | readonly string[]): Promise<void> {
    const list = (Array.isArray(keys) ? keys : [keys]).map((key) => this.resolveKey(key as string));
    if (list.length === 0) return;
    const removed = await this.guarded('del', { count: list.length }, undefined, () => this.store.del(list), () => 0);
    this.metrics.delete(removed);
  }

  /**
   * 是否存在有效键（空值占位算存在）
   * @param key 逻辑键
   */
  async has(key: string): Promise<boolean> {
    const fullKey = this.resolveKey(key);
    return this.guarded('has', { key: fullKey }, undefined, () => this.store.exists(fullKey), () => false);
  }

  /**
   * 重设 TTL
   * @param key 逻辑键
   * @param ttlSeconds TTL（秒）
   * @returns 键存在且成功为 true
   */
  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const fullKey = this.resolveKey(key);
    const ttlMs = this.ttlMs(ttlSeconds, 0);
    return this.guarded('expire', { key: fullKey }, undefined, () => this.store.expire(fullKey, ttlMs), () => false);
  }

  /**
   * 回源包装（最推荐用法）：命中直接返回；未命中回源并写缓存；并发同 key 只回源一次（单飞）
   * @param key 逻辑键
   * @param ttlSeconds TTL（秒）
   * @param loader 回源函数；返回 null/undefined 时写空值占位
   * @param options 覆盖选项（含 tags / loaderTimeoutMs）
   */
  async wrap<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T | undefined | null>,
    options?: CacheCallOptions,
  ): Promise<T | undefined> {
    const fullKey = this.resolveKey(key);
    // 单飞：先同步登记，保证任一并发后续调用都合并到同一次回源（TC-CACHE-004）
    const pending = this.inflight.get(fullKey);
    if (pending) {
      this.metrics.singleFlight();
      return pending as Promise<T | undefined>;
    }
    const promise = this.loadThrough<T>(fullKey, ttlSeconds, loader, options);
    this.inflight.set(fullKey, promise as Inflight);
    try {
      return await promise;
    } finally {
      this.inflight.delete(fullKey);
    }
  }

  /**
   * 按标签批量失效
   * @param tag 标签（如 `user:123`）
   * @returns 失效键数量
   */
  async invalidateTag(tag: string): Promise<number> {
    const fullTagKey = tagKeyOf(this.opt.prefix, tag);
    const members = await this.guarded('invalidateTag.members', { tag }, undefined, () => this.store.smembers(fullTagKey), () => [] as string[]);
    let removed = 0;
    if (members.length > 0) {
      removed = await this.guarded('invalidateTag.del', { tag, count: members.length }, undefined, () => this.store.del(members), () => 0);
      this.metrics.delete(removed);
    }
    await this.guarded('invalidateTag.cleanup', { tag }, undefined, () => this.store.del([fullTagKey]), () => 0);
    this.metrics.tagInvalidation();
    logger.debug('标签失效', { tag, removed });
    return removed;
  }

  /**
   * 连接可用性探测（注册为 `/ready` 探针；memory 恒为 true）
   */
  async ping(): Promise<boolean> {
    return this.guarded('ping', {}, { failOpen: true }, () => this.store.ping(), () => false);
  }

  /** 指标快照 */
  metricsSnapshot(): CacheMetricsSnapshot {
    return this.metrics.snapshot(this.store.kind);
  }

  /** 存储端键数量（观测用） */
  async size(): Promise<number> {
    return this.guarded('size', {}, { failOpen: true }, () => this.store.size(), () => 0);
  }

  /**
   * 获取分布式锁
   * @param key 逻辑键（自动补前缀与锁命名段）
   * @param ttlSeconds TTL（秒），缺省取 `CACHE_LOCK_TTL`
   * @param options 重入 / 续期 / 等待选项
   * @returns 锁句柄；未获取到（含降级）返回 null
   */
  async lock(key: string, ttlSeconds?: number, options?: LockOptions): Promise<LockHandle | null> {
    const fullKey = this.resolveKey(`lock:${key}`);
    const ttlMs = this.ttlMs(ttlSeconds ?? this.opt.lockTtlSeconds, 0);
    return this.guarded('lock', { key: fullKey }, undefined, () => this.lockManager.acquire(fullKey, ttlMs, options), () => null);
  }

  /**
   * 持锁执行（集群内只执行一次）：未获取到锁时不执行并返回 acquired=false（定时任务语义）
   * @param key 锁键
   * @param ttlSeconds TTL（秒）
   * @param fn 持锁回调
   * @param options 锁选项
   */
  async withLock<T>(
    key: string,
    ttlSeconds: number,
    fn: () => Promise<T>,
    options?: LockOptions,
  ): Promise<{ acquired: boolean; value?: T }> {
    const handle = await this.lock(key, ttlSeconds, options);
    if (!handle) return { acquired: false };
    try {
      const value = await fn();
      return { acquired: true, value };
    } finally {
      await this.guarded('unlock', { key }, undefined, () => handle.release(), () => false);
    }
  }

  /** 释放存储连接（优雅停机） */
  async close(): Promise<void> {
    await this.store.close();
  }

  /** 读取实现（入参为完整键） */
  private async readRaw<T>(fullKey: string, options?: CacheCallOptions): Promise<CacheReadResult<T>> {
    const raw = await this.guarded('read', { key: fullKey }, options, () => this.store.get(fullKey), () => undefined);
    if (raw === undefined) {
      this.metrics.miss();
      return { hit: false, value: undefined, kind: undefined };
    }
    const decoded = decodeEntry<T>(raw);
    this.metrics.hit();
    return {
      hit: true,
      value: decoded.kind === 'negative' ? undefined : decoded.value,
      kind: decoded.kind,
    };
  }

  /** 写入实现（入参为完整键）；含大 key 拒绝与标签登记 */
  private async setRaw(fullKey: string, value: unknown, options?: CacheCallOptions): Promise<void> {
    const isNegative = value === undefined || value === null;
    const encoded = isNegative ? encodeNegative() : encodeValue(value);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > this.opt.maxValueBytes) {
      this.metrics.oversized();
      logger.warn('缓存值超过上限，已拒绝写入（大 key 防护）', { key: fullKey, bytes, limit: this.opt.maxValueBytes });
      return;
    }
    const ttlMs = isNegative
      ? this.ttlMs(options?.nullTtlSeconds ?? this.opt.nullTtlSeconds, 0)
      : this.ttlMs(options?.ttlSeconds ?? this.opt.defaultTtlSeconds, options?.jitter);
    await this.guarded('set', { key: fullKey, ttlMs, negative: isNegative }, options, () => this.store.set(fullKey, encoded, ttlMs), () => undefined);
    this.metrics.set();
    // 标签登记：标签映射键 TTL 显著长于业务键，且每次登记续期（防「幽灵缓存」）
    for (const tag of options?.tags ?? []) {
      await this.guarded(
        'tag',
        { key: fullKey, tag },
        options,
        () => this.store.sadd(tagKeyOf(this.opt.prefix, tag), [fullKey], this.opt.tagTtlSeconds * 1000),
        () => undefined,
      );
    }
  }

  /** 单飞回源实现：读 → 回源 → 写（含空值占位） */
  private async loadThrough<T>(
    fullKey: string,
    ttlSeconds: number,
    loader: () => Promise<T | undefined | null>,
    options?: CacheCallOptions,
  ): Promise<T | undefined> {
    const cached = await this.readRaw<T>(fullKey, options);
    if (cached.hit) return cached.value;
    const loaded = await this.callLoader(loader, options?.loaderTimeoutMs);
    await this.setRaw(fullKey, loaded, { ...options, ttlSeconds });
    return loaded === null || loaded === undefined ? undefined : loaded;
  }

  /** 回源调用（可带超时）；回源异常与超时上抛，不吞业务错误 */
  private async callLoader<T>(loader: () => Promise<T | undefined | null>, timeoutMs?: number): Promise<T | undefined | null> {
    if (!timeoutMs || timeoutMs <= 0) return loader();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        loader(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`缓存回源超时（${timeoutMs}ms）`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 统一的故障守卫：计时、降级、错误计数与慢操作告警
   * @param op 操作名
   * @param ctx 日志上下文
   * @param options 调用选项（决定 failOpen）
   * @param run 实际存储调用
   * @param fallback 降级返回值
   */
  private async guarded<T>(
    op: string,
    ctx: Record<string, unknown>,
    options: CacheCallOptions | undefined,
    run: () => Promise<T>,
    fallback: () => T,
  ): Promise<T> {
    const start = Date.now();
    try {
      // 缓存插桩漏斗：全部存储操作经 guarded，缓存 span 在此包住一次调用（未启用追踪时为非记录 span）
      return await withCacheSpan(op, this.store.kind, run);
    } catch (error) {
      this.metrics.error();
      const failOpen = options?.failOpen ?? this.opt.failOpen;
      if (failOpen) {
        this.metrics.degradation();
        logger.warn('缓存降级（fail-open：读直查 / 写忽略）', {
          op,
          ...ctx,
          error: error instanceof Error ? error.message : String(error),
        });
        return fallback();
      }
      throw error instanceof CacheUnavailableError
        ? error
        : new CacheUnavailableError(`缓存操作失败（${op}），CACHE_FAIL_OPEN=false 时不做降级`, error);
    } finally {
      const durationMs = Date.now() - start;
      this.metrics.observe(durationMs);
      if (durationMs >= this.opt.slowMs) {
        logger.warn('慢缓存操作告警', { op, durationMs, thresholdMs: this.opt.slowMs, ...ctx });
      }
    }
  }

  /**
   * 计算实际 TTL（毫秒）：叠加 ±jitter 抖动（防雪崩，PRD-004 FR-08）
   * @param ttlSeconds 基础 TTL（秒）
   * @param jitter 抖动比例（0–1）
   */
  private ttlMs(ttlSeconds: number, jitter?: number): number {
    const ratio = jitter ?? this.opt.ttlJitter;
    const factor = ratio > 0 ? 1 + (Math.random() * 2 - 1) * ratio : 1;
    return Math.max(1, Math.round(ttlSeconds * 1000 * factor));
  }
}

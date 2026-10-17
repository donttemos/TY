/*
 * @file CacheService：统一缓存服务（框架唯一对外缓存入口）
 * @description 在存储端口之上实现 PRD-004 全部能力：统一接口（get/set/del/has/wrap/mget/mset/expire/
 *   invalidateTag）、全局 key 前缀、JSON 信封（区分空值占位）、标签化失效、三大防护
 *   （防穿透=空值占位、防击穿=进程内单飞、防雪崩=TTL 抖动）、大 key 防护、故障降级
 *   （CACHE_FAIL_OPEN）与指标采集。业务代码只依赖本类，切换驱动零改动（AC-002）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo M9/PRD-009 FR-09：新增 updateRuntimeOptions——cache.ttl/nullTtl/ttlJitter/slowMs/lockTtl 五键经配置中心订阅热更
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复（C-01/C-03/A-04）：setRaw 带标签时改走端口
 *   原子方法 `setWithTags`（写值与标签登记单次完成，消除半程状态）；invalidateTag 改走 `invalidateByTag`
 *   （读成员/删成员/删索引单次原子，与并发写入全序串行，故障时整体未发生——fail-open 降级不再
 *   把「无法确认成员」误删成「没有成员」的索引）。
 * @modified 2026-10-17 donttemo Cache 缺陷清单 A-03 修复：① updateRuntimeOptions 增加入口校验
 *   （TTL/空值 TTL/lockTtl 必须为正数、jitter ∈ [0,1]、slowMs ≥ 0），非法热更 fail-fast——
 *   「合法性由配置中心保证」降级为第二道防线而非唯一防线；② 调用级 ttlSeconds/nullTtlSeconds/
 *   expire/lock 的 TTL 校验（此前 ttlMs() 用 Math.max(1,·) 把非法值钳到 1ms 静默写入）；
 *   ③ mset 契约显式化：非事务、逐键写入、中途失败可能留下部分键。
 * @module @fw/cache
 */

import { Logger } from '@fw/logger';
import { BizError, ErrorCode } from '@fw/core';
import { CacheUnavailableError } from './errors.js';
import { assertLogicalKey, decodeEntry, encodeNegative, encodeValue, tagKeyOf, withPrefix } from './key.js';
import { LockManager, type LockHandle, type LockOptions } from './lock.js';
import { CacheMetrics } from './metrics.js';
import { withCacheSpan } from './trace.js';
import type { CacheStorePort } from './store.port.js';
import type { CacheCallOptions, CacheDriverName, CacheMetricsSnapshot, CacheReadResult, CacheRuntimeOptions } from './types.js';

const logger = Logger.for('cache');

/** 秒级 TTL 校验（A-03）：必须为正的有限数值（此前 ttlMs() 用 Math.max(1,·) 把非法值钳到 1ms 静默写入） */
function assertPositiveSeconds(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `缓存配置非法：${field} 必须为正数（秒），收到 ${value}`);
  }
}

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
   * 运行时更新可热更选项（M9/PRD-009 FR-09：由配置中心 onChange 订阅调用，禁止业务侧自行轮询）
   *
   * 仅接受白名单键对应的字段（ttl/nullTtl/ttlJitter/slowMs/lockTtl）；lockTtl 同步刷新锁管理器默认 TTL
   * （对后续新获取的锁生效，在途锁不受影响）。入口校验（A-03）：TTL/空值 TTL/lockTtl 必须为正数、
   * jitter ∈ [0,1]、slowMs ≥ 0——非法热更 fail-fast 抛 BizError CONFIG_INVALID_VALUE，
   * 配置中心管道校验为第一道防线、此处为直接调用者的兜底防线。
   * @param patch 待更新字段
   */
  updateRuntimeOptions(
    patch: Partial<Pick<CacheRuntimeOptions, 'defaultTtlSeconds' | 'nullTtlSeconds' | 'ttlJitter' | 'slowMs' | 'lockTtlSeconds'>>,
  ): void {
    if (patch.defaultTtlSeconds !== undefined) assertPositiveSeconds(patch.defaultTtlSeconds, 'defaultTtlSeconds');
    if (patch.nullTtlSeconds !== undefined) assertPositiveSeconds(patch.nullTtlSeconds, 'nullTtlSeconds');
    if (patch.lockTtlSeconds !== undefined) assertPositiveSeconds(patch.lockTtlSeconds, 'lockTtlSeconds');
    if (patch.ttlJitter !== undefined) {
      const { ttlJitter } = patch;
      if (!Number.isFinite(ttlJitter) || ttlJitter < 0 || ttlJitter > 1) {
        throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `缓存配置非法：ttlJitter 必须在 [0,1] 内，收到 ${ttlJitter}`);
      }
    }
    if (patch.slowMs !== undefined) {
      const { slowMs } = patch;
      if (!Number.isFinite(slowMs) || slowMs < 0) {
        throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `缓存配置非法：slowMs 必须为 ≥0 的有限数值，收到 ${slowMs}`);
      }
    }
    Object.assign(this.opt, patch);
    if (patch.lockTtlSeconds !== undefined) {
      this.lockManager.updateDefaultTtl(patch.lockTtlSeconds * 1000);
    }
    logger.info('缓存运行时选项已热更', { ...patch });
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
   *
   * 契约（A-03 显式化）：**非事务**——逐键调用 setRaw，中途失败时可能已经写入部分键，
   * 不做回滚。需要「全有或全无」语义的场景不得从「批量」一词推断原子性，应使用存储层
   * 事务能力或自行补偿。
   *
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
    assertPositiveSeconds(ttlSeconds, 'ttlSeconds');
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
   *
   * 原子语义（C-01/C-03 修复）：走端口 `invalidateByTag`——读成员、删成员、删索引单次原子完成，
   * 与 `setWithTags` 的写+登记全序串行：失效期间/之后完成登记的键要么已被删除、要么重新持有
   * 有效索引，不再产生「键存在但索引已丢」的孤儿；操作故障时整体未发生（fail-open 降级返回 0
   * 且**不销毁索引**，fail-closed 抛 9002），不会把「无法确认成员」误判为「没有成员」。
   * @param tag 标签（如 `user:123`）
   * @returns 失效键数量（故障降级时为 0，可观测的失败语义）
   */
  async invalidateTag(tag: string): Promise<number> {
    const fullTagKey = tagKeyOf(this.opt.prefix, tag);
    const removed = await this.guarded('invalidateTag', { tag }, undefined, () => this.store.invalidateByTag(fullTagKey), () => 0);
    if (removed > 0) {
      this.metrics.delete(removed);
    }
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
    if (ttlSeconds !== undefined) assertPositiveSeconds(ttlSeconds, 'ttlSeconds');
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

  /** 写入实现（入参为完整键）；含大 key 拒绝与 TTL 校验。带标签时走端口原子方法（C-01/A-04 修复） */
  private async setRaw(fullKey: string, value: unknown, options?: CacheCallOptions): Promise<void> {
    const isNegative = value === undefined || value === null;
    const encoded = isNegative ? encodeNegative() : encodeValue(value);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > this.opt.maxValueBytes) {
      this.metrics.oversized();
      logger.warn('缓存值超过上限，已拒绝写入（大 key 防护）', { key: fullKey, bytes, limit: this.opt.maxValueBytes });
      return;
    }
    // 调用级 TTL 校验（A-03）：非法值 fail-fast，不再被 ttlMs() 钳到 1ms 静默写入
    if (!isNegative && options?.ttlSeconds !== undefined) assertPositiveSeconds(options.ttlSeconds, 'ttlSeconds');
    if (options?.nullTtlSeconds !== undefined) assertPositiveSeconds(options.nullTtlSeconds, 'nullTtlSeconds');
    const ttlMs = isNegative
      ? this.ttlMs(options?.nullTtlSeconds ?? this.opt.nullTtlSeconds, 0)
      : this.ttlMs(options?.ttlSeconds ?? this.opt.defaultTtlSeconds, options?.jitter);
    const tags = options?.tags ?? [];
    if (tags.length === 0) {
      await this.guarded('set', { key: fullKey, ttlMs, negative: isNegative }, options, () => this.store.set(fullKey, encoded, ttlMs), () => undefined);
    } else {
      // 写值与标签登记单次原子完成（此前两步分离：值已写入而标签登记失败/被并发失效吞掉，
      // 会留下「有值无索引」或「失效后残留旧值」——现由 setWithTags 消除半程状态）
      const tagEntries = tags.map((tag) => ({ tagKey: tagKeyOf(this.opt.prefix, tag), ttlMs: this.opt.tagTtlSeconds * 1000 }));
      await this.guarded(
        'set+tags',
        { key: fullKey, ttlMs, negative: isNegative, tags },
        options,
        () => this.store.setWithTags(fullKey, encoded, ttlMs, tagEntries),
        () => undefined,
      );
    }
    this.metrics.set();
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

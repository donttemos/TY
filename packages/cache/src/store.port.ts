/*
 * @file 缓存存储端口（CacheStorePort）
 * @description 框架自有的最底层 KV 抽象：只暴露字符串读写、TTL、集合（标签映射）与条件操作。
 *   memory 与 redis 两种驱动实现同一端口，CacheService 只依赖本端口，
 *   因此切换驱动时业务与服务层 diff = 0（PRD-004 FR-02 / AC-002）。
 *   本文件不得出现任何驱动特有类型（ioredis / Redis 类型）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-16 donttemo 驱动审查修复：文档化两处端口契约——size() 为观测近似值
 *   （memory=本进程条目 / redis=DBSIZE 整库，两驱动数值不可直接对比）；tokenBucketTake 的
 *   retryAfterMs 增加 -1 哨兵语义（cost > capacity 时永不可满足，不得当作可立即重试）
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复（C-01/C-03/A-04）：新增两个原子端口方法——
 *   `setWithTags`（写值与标签登记单次原子完成，消除「值已写入、标签未登记」的半程状态）与
 *   `invalidateByTag`（读成员、删成员、删索引单次原子完成，消除失效与并发写入的竞态窗口，
 *   且故障时整体未发生——fail-open 降级不再误删索引）。两个方法均为**多键操作**：
 *   redis-cluster 模式下跨 slot 的多键 Lua 会被拒绝（CROSSSLOT），标签能力在 cluster 下
 *   需 hash-tag 同 slot 或退化为不可用（已知限制，与 size() 观测限制同级登记）。
 *   Cluster 兼容策略（约束分析 / hash tag 方案评估 / prefix 作用域定案）见 **ADR-0028**；
 *   单实例真实 Redis 验证见 `__tests__/redis-integration.test.ts`（CI service）。
 * @modified 2026-10-18 donttemo 复核修复（P1）：`setWithTags` 契约补齐原子性口径——「不可交错执行」
 *   ≠「事务回滚」，确定性错误（标签键类型不符 / 标签键撞值键）必须由写前预检保证零写入；
 *   同步修正 C-01 编号笔误（C-04 → A-04）。
 * @modified 2026-10-19 donttemo P1 加固：`setWithTags` 契约再补**写序**约束——预检 → 先登记标签索引 →
 *   最后写值。残留故障因此只可能落在「幽灵索引」（索引指向不存在键，失效无副作用且 TTL 自回收），
 *   不允许落在「孤儿缓存」（有值无索引，标签失效永远触达不到）。
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
 *   redis 驱动用 Lua 保证原子，memory 驱动用单线程语义保证；
 * - `size()` 为**观测近似值**，语义随驱动不同不可直接对比：memory = 本进程有效条目数，
 *   redis = `DBSIZE` 整库键数（含其他应用的键）。仅用于容量/内存观测与告警，禁止参与业务判定。
 */
/** 令牌桶取令牌结果（M10 E-03） */
export interface TokenBucketTakeResult {
  /** 是否取得令牌（桶内余额 ≥ cost） */
  allowed: boolean;
  /** 取令牌后的桶内余额（向下取整） */
  remaining: number;
  /**
   * 余额不足时建议的等待毫秒数（攒够 cost 个令牌所需时间；allowed=true 时为 0）。
   * **-1 = 永不可满足**：cost > capacity（或 refill ≤ 0）的配置错误，等待无意义——
   * 调用方不得把 -1 或旧语义下的 0 当作「立即重试可行」。
   */
  retryAfterMs: number;
}

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
  /**
   * 令牌桶原子取令牌（M10 E-03 限流原语）：对 key 桶按流逝时间补充令牌并扣减 cost 个。
   * 跨驱动语义一致——memory 为进程内惰性补充（零序列化开销），redis 为 Lua 原子脚本
   * （多实例共享同一桶）。桶键 TTL 由实现自管（建议 = 桶自然回满时间，防止冷桶永驻）。
   */
  tokenBucketTake(
    key: string,
    capacity: number,
    refillPerSecond: number,
    cost: number,
    nowMs: number,
  ): Promise<TokenBucketTakeResult>;

  /**
   * 带标签登记的原子写入（C-01/A-04 修复 + 2026-10-18 复核加固）：写值与向各标签集合登记本键
   * 在**单次不可交错的脚本执行**内完成；确定性错误（标签键类型不符 / 标签键与值键同名）在
   * **任何写操作之前预检**，失败即零写入——不存在「值已写入、标签未登记」或「标签已登记、
   * 值写入失败」的半程状态。
   *
   * 原子性口径（精确）：不可交错执行（isolation）**不等于事务回滚**——预检通过后的资源类故障
   * （OOM / 只读副本等）仍可能保留已执行的写命令。因此驱动必须把所有**确定性**错误收敛到写前
   * 预检阶段，调用方不得把本方法当作「失败即整体回滚」的事务使用。
   *
   * 写序约束（2026-10-19）：预检 → **先登记标签索引** → **最后写值**。既然无法回滚，就要让残留
   * 故障落在无害方向：最坏情形是「索引指向一个不存在的键」的幽灵索引（标签失效 DEL 不存在的键
   * 无副作用，标签集合自身 TTL 到期即回收），绝不允许出现「有值无索引」的孤儿缓存（标签失效
   * 永远触达不到，只能等业务 TTL，等于把 C-01 的缺口重新打开）。
   * @param key 完整缓存键
   * @param value 已编码的缓存值
   * @param ttlMs 值 TTL（毫秒）
   * @param tags 标签列表（tagKey 为完整标签映射键，ttlMs 为映射集合 TTL）
   */
  setWithTags(
    key: string,
    value: string,
    ttlMs: number,
    tags: ReadonlyArray<{ tagKey: string; ttlMs: number }>,
  ): Promise<void>;

  /**
   * 原子标签失效（C-01/C-03 修复）：读取成员 → 删除全部成员键 → 删除标签集合**单次原子完成**。
   * 与 `setWithTags` 全序串行后，失效期间/之后完成登记的键要么已被删除、要么重新持有有效索引，
   * 不再出现「键存在但索引已丢」的孤儿。操作失败时**整体未发生**（fail-open 降级不得销毁索引）。
   * @param tagKey 完整标签映射键
   * @returns 实际删除的成员键数量（标签集合不存在时为 0）
   */
  invalidateByTag(tagKey: string): Promise<number>;

  /** 可用性探测 */
  ping(): Promise<boolean>;
  /** 释放连接（优雅停机） */
  close(): Promise<void>;
  /** 当前有效键数量（**观测近似值，语义随驱动**：见文件头约定，禁止业务判定用） */
  size(): Promise<number>;
}

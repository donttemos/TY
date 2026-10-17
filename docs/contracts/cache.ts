/*
 * @file C-04 缓存与锁契约（类型即契约，冻结）
 * @description 并行工作线契约（docs/85-parallel-workstreams.md 表 C-04）：L3 实现、L2/L4 消费。
 *   本文件声明缓存层对外部可观测的**结构与语义**，不含实现：统一读写接口、key 规范、
 *   标签失效、三防护（穿透/击穿/雪崩）、降级语义（CACHE_FAIL_OPEN）、分布式锁与指标快照。
 *   实现方（@fw/cache）签名必须与本契约一致；消费方（@fw/auth 的权限缓存、管理后台前端、
 *   代码生成器模板）照此写适配器与类型，无需等待实现。
 *   冻结后修改需走契约变更（L0 独占维护），不得由消费线私自改签名。
 * @author donttemo
 * @created 2026-10-13
 * @module docs/contracts
 */

/** 缓存键：已含全局前缀的完整键，或将被 CacheService 补前缀的逻辑键 */
export type CacheKey = string;

/**
 * 缓存标签：用于批量失效（如 `user:123`、`order`）
 * @example 'user:123' | 'dict' | 'menu'
 */
export type CacheTag = string;

/** 缓存驱动名（由 CACHE_DRIVER 决定，消费方不得分支判断） */
export type CacheDriverName = 'memory' | 'redis' | 'redis-cluster';

/** 缓存故障时的降级策略：`true` = 读直查/写忽略（fail-open）；`false` = 抛 9002（fail-closed） */
export type FailOpen = boolean;

/** 缓存写入信封：`positive` 为真实值，`negative` 为空值占位（防穿透，消费方按未命中处理） */
export type CacheEntryKind = 'positive' | 'negative';

/** 内部读取结果（`wrap` / 三防护据此区分「真空值」与「真未命中」） */
export interface CacheReadResult<T> {
  /** 是否命中（空值占位也算命中，避免回源） */
  hit: boolean;
  /** 命中值；`negative` 时为 undefined */
  value: T | undefined;
  /** 命中类型；未命中为 undefined */
  kind: CacheEntryKind | undefined;
}

/** 单次读写选项（不传则用运行时默认配置） */
export interface CacheOptions {
  /** 覆盖默认 TTL（秒）；`0` 或负值非法 */
  ttlSeconds?: number;
  /** 关联标签：写入时登记，`invalidateTag` 时批量失效 */
  tags?: CacheTag[];
  /** 空值占位 TTL（秒），默认取 `CACHE_NULL_TTL` */
  nullTtlSeconds?: number;
  /** TTL 抖动比例（0–1），默认取 `CACHE_TTL_JITTER`；防雪崩 */
  jitter?: number;
  /** 是否允许故障降级，默认取 `CACHE_FAIL_OPEN` */
  failOpen?: FailOpen;
  /** 回源超时（毫秒），超时视为未命中；默认不限制 */
  loaderTimeoutMs?: number;
}

/**
 * 统一缓存接口（框架自有，不暴露 ioredis / cache-manager 类型）
 *
 * 语义约定（冻结）：
 * - `get` 对「未命中」与「空值占位」均返回 `undefined`；需要区分时用 `read`；
 * - `set` 的 `ttlSeconds` 必须为正数，禁止无 TTL 缓存（防脏数据）；
 * - 大 key 防护：序列化后超过 `CACHE_MAX_VALUE_BYTES` 拒绝写入并告警（P2，TC-CACHE-010）；
 * - 降级：`CACHE_FAIL_OPEN=true` 时读失败直查、写失败忽略，且指标 `degradations` 计数 +1；
 *   `false` 时抛 `CacheUnavailableError`（映射错误码 9002 / HTTP 503）。
 *
 * | 场景 | fail-open | fail-closed |
 * |---|---|---|
 * | 读故障 | 返回 undefined（上层直查） | 抛 9002 |
 * | 写故障 | 忽略并告警 | 抛 9002 |
 * | 锁故障 | 返回 null（上层降级执行） | 抛 9002 |
 */
export interface CacheServiceContract {
  /** 读取；未命中或空值占位返回 undefined */
  get<T>(key: CacheKey, options?: CacheOptions): Promise<T | undefined>;
  /** 读取（含命中类型，供三防护与观测使用） */
  read<T>(key: CacheKey, options?: CacheOptions): Promise<CacheReadResult<T>>;
  /** 写入（`value` 为 undefined 时写空值占位） */
  set(key: CacheKey, value: unknown, options?: CacheOptions): Promise<void>;
  /**
   * 批量写入。
   * 契约（A-03 冻结）：**非事务**——逐键写入，中途失败时可能已写入部分键，不做回滚；
   * 需要「全有或全无」语义的场景不得使用本接口推断原子性。
   */
  mset(entries: ReadonlyArray<{ key: CacheKey; value: unknown; tags?: CacheTag[] }>, options?: CacheOptions): Promise<void>;
  /** 批量读取；返回 Map（未命中键不在 Map 中） */
  mget<T>(keys: readonly CacheKey[], options?: CacheOptions): Promise<Map<CacheKey, T>>;
  /** 删除键（幂等） */
  del(keys: CacheKey | readonly CacheKey[]): Promise<void>;
  /** 是否存在**有效**键（空值占位算存在） */
  has(key: CacheKey): Promise<boolean>;
  /** 重设 TTL（键不存在时返回 false） */
  expire(key: CacheKey, ttlSeconds: number): Promise<boolean>;
  /**
   * 回源包装（**最推荐用法**）：命中直接返回；未命中调用 `loader` 并写缓存。
   * - 并发同 key 只回源一次（单飞 / 防击穿，TC-CACHE-004）；
   * - `loader` 返回 null/undefined 时写空值占位（防穿透，TC-CACHE-005）。
   */
  wrap<T>(key: CacheKey, ttlSeconds: number, loader: () => Promise<T | undefined | null>, options?: CacheOptions): Promise<T | undefined>;
  /**
   * 按标签批量失效；返回失效键数量。
   * 原子语义（C-01/C-03 冻结）：写+登记（`set` 带 tags）与失效各自原子、彼此全序串行——
   * 失效后任何存活键必仍可被再次失效（无孤儿）；失效故障时整体未发生（fail-open 返回 0 且
   * 不销毁索引，fail-closed 抛 9002）。已知限制：redis-cluster 跨 slot 多键脚本不可用
   * （Cluster 兼容策略与 prefix 作用域 hash tag 定案见 ADR-0028；单实例真实 Redis 验证见
   * `packages/cache/src/__tests__/redis-integration.test.ts`）。
   */
  invalidateTag(tag: CacheTag): Promise<number>;
  /** 连接可用性探测（注册为 `/ready` 探针；memory 恒为 true） */
  ping(): Promise<boolean>;
  /** 指标快照（供 `/metrics` 渲染） */
  metrics(): CacheMetricsSnapshot;
}

/** 分布式锁句柄（`lock` 返回 null 表示未获取到） */
export interface LockHandle {
  /** 锁键（含全局前缀） */
  readonly key: CacheKey;
  /** 持有者令牌（释放与续期时校验，防误删他人锁） */
  readonly token: string;
  /** 当前 TTL（毫秒） */
  readonly ttlMs: number;
  /** 是否可重入获取（同一持有者重复 acquire） */
  readonly reentrant: boolean;
  /**
   * 释放：仅当令牌匹配时删除；返回是否真的释放。
   * 语义（冻结，C-02）：释放行为由**共享持有记录的深度**决定——深度 > 1 时只减深度
   * （与本句柄当初是普通获取还是重入获取无关），深度 = 1 时真正释放；重复释放幂等返回 false。
   */
  release(): Promise<boolean>;
  /** 续期（自动续期开启时由看门狗周期调用）；返回是否成功 */
  renew(ttlMs?: number): Promise<boolean>;
}

/** 获取锁的选项 */
export interface LockOptions {
  /** 允许同持有者重入（默认 false） */
  reentrant?: boolean;
  /** 自动续期（默认 false）：开启后每 `max(50ms, ttlMs/3)` 续期一次，`release` 时停表；
   *  TTL < 1s 时续期可靠性受限（实现侧告警），持续失锁通过 `onLost` 感知 */
  autoRenew?: boolean;
  /** 持有者标识（默认进程内自动生成，跨实例需显式传入业务唯一标识） */
  owner?: string;
  /** 等待获取的最大毫秒数（默认 0 = 不等待，立即返回） */
  waitMs?: number;
  /** 失锁感知（C-04）：`autoRenew` 开启时看门狗续期失败/异常停表后触发一次；
   *  持锁副作用不可重复的业务应据此中止执行 */
  onLost?: (reason: 'renew-failed' | 'renew-error') => void;
}

/**
 * 标签失效实现约定（防「幽灵缓存」，PRD-004 §8）：
 * - 标签 → 键集合的映射独立存储，键名为 `<前缀>:__tag__:<tag>`；
 * - 映射自身 TTL 显著长于业务键（默认 24h），并在每次登记时续期；
 * - 映射缺失不视为失败（标签过期等价于无需失效）。
 */
export interface TagStoreContract {
  /** 登记键到标签 */
  tag(key: CacheKey, tags: readonly CacheTag[]): Promise<void>;
  /** 失效标签下全部键，返回失效键数量 */
  invalidate(tag: CacheTag): Promise<number>;
}

/**
 * `@Cacheable` 装饰器选项（冻结）
 * - `key` 缺省为 `<类名>:<方法名>:<参数稳定哈希>`；
 * - `condition` 为假时不读不写（如「仅缓存未登录可见数据」）；
 * - `tags` 支持 `${参数索引}` 占位（如 `['user:${0}']`）。
 */
export interface CacheableOptions {
  /** TTL（秒） */
  ttl: number;
  /** 关联标签（支持 `${索引}` 占位） */
  tags?: CacheTag[];
  /** 完整覆盖默认 key 生成 */
  key?: string;
  /** 是否启用缓存；返回 false 时跳过缓存（不写不读） */
  condition?: (...args: unknown[]) => boolean;
  /** 空值占位 TTL（秒） */
  nullTtlSeconds?: number;
  /** TTL 抖动比例 */
  jitter?: number;
}

/** 指标快照（`/metrics` 与日志同源） */
export interface CacheMetricsSnapshot {
  /** 驱动名 */
  driver: CacheDriverName;
  /** 命中次数（含空值占位命中） */
  hits: number;
  /** 未命中次数 */
  misses: number;
  /** 写入次数 */
  sets: number;
  /** 删除次数 */
  deletes: number;
  /** 标签失效次数 */
  tagInvalidations: number;
  /** 单飞合并的回源次数（被合并掉的并发请求数） */
  singleFlightMerged: number;
  /** 降级次数（依赖故障 fail-open 生效） */
  degradations: number;
  /** 错误次数（含 fail-closed 抛出） */
  errors: number;
  /** 大 key 拒绝次数（TC-CACHE-010） */
  oversizedRejected: number;
  /** 累计操作耗时（毫秒）与次数，命中率 = hits / (hits + misses) */
  latencyMs: number;
  operations: number;
}

/** 降级语义常量（与错误码表 9002 / `docs/40-api-spec.md` §2 同源） */
export interface CacheDegradationContract {
  /** 依赖不可用（fail-closed 时抛出），HTTP 503 */
  DEPENDENCY_UNAVAILABLE: 9002;
}

/** 指标暴露路径（免认证，见 C-05 `DEFAULT_PUBLIC_PATHS`） */
export declare const CACHE_METRICS_PATH: '/metrics';

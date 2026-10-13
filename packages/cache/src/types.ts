/*
 * @file 缓存层公共类型
 * @description 运行时配置、驱动名、读写选项与指标快照的内部形状；
 *   对外契约以 docs/contracts/cache.ts（C-04）为准，本文件不得出现契约外的公共语义改动。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

/** 缓存驱动名（CACHE_DRIVER） */
export type CacheDriverName = 'memory' | 'redis' | 'redis-cluster';

/** 缓存条目类型：真实值 / 空值占位（防穿透） */
export type CacheEntryKind = 'positive' | 'negative';

/** 运行时配置（由环境变量构建，见 CacheModule.buildCacheOptions） */
export interface CacheRuntimeOptions {
  /** 驱动名 */
  driver: CacheDriverName;
  /** 连接串（redis / redis-cluster 必填） */
  url: string | undefined;
  /** key 全局前缀（已解析，不留空） */
  prefix: string;
  /** 默认 TTL（秒） */
  defaultTtlSeconds: number;
  /** memory 驱动容量上限 */
  maxItems: number;
  /** 故障降级开关（fail-open） */
  failOpen: boolean;
  /** 空值占位 TTL（秒） */
  nullTtlSeconds: number;
  /** TTL 抖动比例（0–1） */
  ttlJitter: number;
  /** 分布式锁默认 TTL（秒） */
  lockTtlSeconds: number;
  /** 标签映射 TTL（秒） */
  tagTtlSeconds: number;
  /** 慢操作告警阈值（毫秒） */
  slowMs: number;
  /** 单 key 值字节上限 */
  maxValueBytes: number;
}

/** 单次读写选项（部分覆盖运行时默认值） */
export interface CacheCallOptions {
  /** 覆盖默认 TTL（秒） */
  ttlSeconds?: number;
  /** 关联标签 */
  tags?: string[];
  /** 空值占位 TTL（秒） */
  nullTtlSeconds?: number;
  /** TTL 抖动比例 */
  jitter?: number;
  /** 是否允许故障降级 */
  failOpen?: boolean;
  /** 回源超时（毫秒） */
  loaderTimeoutMs?: number;
}

/** 读取结果（区分真空值与真未命中） */
export interface CacheReadResult<T> {
  /** 是否命中（空值占位也算命中） */
  hit: boolean;
  /** 命中值；空值占位为 undefined */
  value: T | undefined;
  /** 命中类型 */
  kind: CacheEntryKind | undefined;
}

/** 指标快照（与 C-04 契约 `CacheMetricsSnapshot` 同源） */
export interface CacheMetricsSnapshot {  /** 驱动名 */
  driver: CacheDriverName;
  /** 命中次数 */
  hits: number;
  /** 未命中次数 */
  misses: number;
  /** 写入次数 */
  sets: number;
  /** 删除次数 */
  deletes: number;
  /** 标签失效次数 */
  tagInvalidations: number;
  /** 单飞合并次数 */
  singleFlightMerged: number;
  /** 降级次数 */
  degradations: number;
  /** 错误次数 */
  errors: number;
  /** 大 key 拒绝次数 */
  oversizedRejected: number;
  /** 累计操作耗时（毫秒） */
  latencyMs: number;
  /** 累计操作次数 */
  operations: number;
}

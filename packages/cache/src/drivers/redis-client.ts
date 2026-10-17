/*
 * @file redis 客户端构造（懒加载 ioredis）
 * @description 仅在 CACHE_DRIVER=redis / redis-cluster 时经动态 import 加载 ioredis，
 *   memory 驱动下 ioredis 不进入依赖图（PRD-004 AC-001：小系统零 Redis 依赖）。
 *   ioredis 声明为 **optional peerDependency**：只用 memory 的项目不必安装它。
 *   客户端类型以本文件的最小接口 RedisClientLike 描述，避免框架层泄漏 ioredis 类型（ADR-0004）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-16 donttemo 驱动审查修复：① 集群连接串支持凭据（redis://:pwd@host:port），
 *   密码进 redisOptions.password——此前用户信息被当进 host 解析，集群直接连不上；
 *   ② 单实例与 Cluster 统一设置 retryStrategy(() => 200)（此前仅 Cluster 有，两形态重连节奏不一致），
 *   并修正 COMMON_OPTIONS 注释与实际行为不符的问题；③ error 告警日志加节流
 *   （Redis 抖动时同一条 warn 不再刷爆日志，静默期计数折叠进下一条）；
 *   ④ Cluster 构造入参按最小结构显式类型化，去除 as never。
 * @module @fw/cache
 */

import { Logger } from '@fw/logger';
import { BizError, ErrorCode } from '@fw/core';
import type { CacheDriverName } from '../types.js';

const logger = Logger.for('cache.redis');

/** error 告警节流窗口（毫秒）：窗口内静默计数，窗口后合并输出一条 */
const WARN_THROTTLE_MS = 5000;

/** 框架使用到的 Redis 命令子集（ioredis 天然满足；测试用 fake 实现） */
export interface RedisClientLike {
  /** 读取单键，不存在返回 null */
  get(key: string): Promise<string | null>;
  /** SET 支持 `PX <ms>` 与 `NX` 选项 */
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  /** 删除若干键，返回删除数量 */
  del(...keys: string[]): Promise<number>;
  /** 判断存在，返回 1/0 */
  exists(key: string): Promise<number>;
  /** 设置毫秒级 TTL，返回 1/0 */
  pexpire(key: string, ms: number): Promise<number>;
  /** 批量读取 */
  mget(...keys: string[]): Promise<Array<string | null>>;
  /** 集合写入 */
  sadd(key: string, ...members: string[]): Promise<number>;
  /** 集合读取 */
  smembers(key: string): Promise<string[]>;
  /** 执行 Lua 脚本 */
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  /** 探测连通性 */
  ping(): Promise<string>;
  /** 关闭连接 */
  quit(): Promise<unknown>;
  /** 立即断开（quit 失败时兜底） */
  disconnect(): void;
  /** 当前库键数量（近似） */
  dbsize(): Promise<number>;
  /** 订阅事件（error 必须监听，否则未捕获事件会导致进程退出） */
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

/** ioredis 构造器结构（动态 import 后的最小依赖面） */
interface IoredisModule {
  default: IoredisCtor;
  Cluster: IoredisCtor;
}

/** ioredis 构造器结构 */
interface IoredisCtor {
  new (urlOrOptions: unknown, options?: Record<string, unknown>): RedisClientLike;
  Cluster?: unknown;
}

/** 单实例客户端选项 */
const COMMON_OPTIONS: Record<string, unknown> = {
  // 每个在途命令最多重试 1 次，仍未打通即向调用方报错（由 CacheService 按 CACHE_FAIL_OPEN 降级）；
  // enableOfflineQueue 默认开启——断连瞬间入队的命令在重试耗尽后失败，不会无限排队
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
  lazyConnect: false,
  enableReadyCheck: true,
};

/** 连接层重连节奏（单实例与 Cluster 一致）：每 200ms 重试一次，直到恢复 */
const RETRY_STRATEGY = (): number => 200;

/** Cluster 构造入参（最小结构；与 Record 交叉以满足 IoredisCtor 的 options 形参，替代 as never） */
type ClusterOptions = Record<string, unknown> & {
  redisOptions: Record<string, unknown>;
  clusterRetryStrategy: () => number;
};

/** 集群节点解析结果 */
export interface ClusterNodesInfo {
  /** 启动节点列表 */
  nodes: Array<{ host: string; port: number }>;
  /** 从连接串凭据段提取的密码（任一节点带凭据即生效；无凭据为 undefined） */
  password: string | undefined;
}

/**
 * 按驱动名创建 Redis 客户端
 * @param driver 驱动名（redis / redis-cluster）
 * @param url 连接串：单实例 `redis://host:port`；集群为逗号分隔的 `host:port` 列表
 * @returns 客户端（已挂 error 监听，避免未捕获异常）
 * @throws Error 缺少连接串或未安装 ioredis
 */
export async function createRedisClient(driver: CacheDriverName, url: string | undefined): Promise<RedisClientLike> {
  if (!url) {
    throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `CACHE_DRIVER=${driver} 时必须配置 CACHE_URL（如 redis://127.0.0.1:6379）`);
  }
  let mod: IoredisModule;
  try {
    mod = (await import('ioredis')) as unknown as IoredisModule;
  } catch (cause) {
    const unavailable = new BizError(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      `未安装 ioredis：CACHE_DRIVER=${driver} 需要 ioredis（pnpm add ioredis）。memory 驱动无需安装。`,
    );
    (unavailable as { cause?: unknown }).cause = cause;
    throw unavailable;
  }

  let client: RedisClientLike;
  if (driver === 'redis-cluster') {
    const { nodes, password } = parseClusterNodes(url);
    const options: ClusterOptions = {
      redisOptions: { ...COMMON_OPTIONS, ...(password !== undefined ? { password } : {}) },
      clusterRetryStrategy: RETRY_STRATEGY,
    };
    client = new mod.Cluster(nodes, options);
  } else {
    client = new mod.default(url, { ...COMMON_OPTIONS, retryStrategy: RETRY_STRATEGY });
  }

  // ioredis 的 error 事件不消费会导致进程崩溃；此处降级为告警日志（观测指标由 CacheService 记录）。
  // 节流：Redis 抖动会产生 error 风暴，同窗口内只输出一条并折叠计数，避免刷爆日志
  let lastWarnAt = 0;
  let suppressed = 0;
  client.on('error', (error) => {
    const now = Date.now();
    if (now - lastWarnAt < WARN_THROTTLE_MS) {
      suppressed++;
      return;
    }
    const folded = suppressed;
    suppressed = 0;
    lastWarnAt = now;
    logger.warn('Redis 连接异常（缓存将按 CACHE_FAIL_OPEN 降级）', {
      driver,
      ...(folded > 0 ? { suppressedErrors: folded } : {}),
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return client;
}

/**
 * 解析集群节点列表（含凭据段）
 * @param url 逗号分隔的节点（`host:port` / `redis://host:port` / `redis://:pwd@host:port`）
 * @returns 节点数组与凭据段密码（无凭据时 password 为 undefined）
 */
export function parseClusterNodes(url: string): ClusterNodesInfo {
  let password: string | undefined;
  const nodes = url
    .split(',')
    .map((node) => node.trim())
    .filter((node) => node.length > 0)
    .map((node) => {
      const cleaned = node.replace(/^rediss?:\/\//, '');
      // 凭据段 `[user:]pwd@`：密码对集群所有节点统一生效（ioredis Cluster 的 startupNodes 不带密码）
      const at = cleaned.lastIndexOf('@');
      let hostPart = cleaned;
      if (at >= 0) {
        const userinfo = cleaned.slice(0, at);
        hostPart = cleaned.slice(at + 1);
        const colon = userinfo.indexOf(':');
        password = colon >= 0 ? userinfo.slice(colon + 1) : userinfo;
      }
      const [host, port = '6379'] = hostPart.split(':');
      return { host, port: Number.parseInt(port, 10) };
    });
  return { nodes, password };
}

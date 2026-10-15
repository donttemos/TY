/*
 * @file 框架级 API 限流（M10 E-03）
 * @description G5「限流默认开启」的框架级兜底：令牌桶（状态存 CacheStorePort——memory 驱动进程内、
 *   redis 驱动 Lua 原子脚本多实例共享），按客户端 IP 维度（中间件位于鉴权守卫之前拿不到用户身份）。
 *   白名单路径前缀豁免（健康探针与 metrics 等运维面）；存储故障 fail-open 可配（与 cache 三防护同构）；
 *   灰度 dry-run 仅计数告警不拦截（非「关闭」——桶与计数照常运转，满足「不可整体关闭」与「观测先行」）。
 *   拒绝返回 429 + `9003`（既有 RATE_LIMITED 错误码，HTTP 429 已在 @fw/core 映射）。
 *   单请求额外开销：memory 驱动 P95 ≤ 1ms（进程内惰性补充，无序列化）。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/cache
 */

import { Inject, Injectable, type CallHandler, type NestMiddleware } from '@nestjs/common';
import { Logger } from '@fw/logger';
import type { CacheStorePort } from './store.port.js';
import { RATE_LIMIT_LIMITER } from './tokens.js';

const logger = Logger.for('cache.rate-limit');

/** 限流器选项 */
export interface RateLimitLimiterOptions {
  /** 存储端口（令牌桶状态载体：memory = 进程内 / redis = Lua 原子共享） */
  store: CacheStorePort;
  /** 桶容量（每 IP 突发上限） */
  capacity: number;
  /** 每秒补充令牌数（稳态吞吐上限） */
  refillPerSecond: number;
  /** 豁免路径前缀（精确前缀匹配；健康探针与 metrics 必须豁免） */
  whitelist: readonly string[];
  /** 存储故障时放行（fail-open）；false = fail-closed 全拒绝 */
  failOpen: boolean;
  /** 灰度模式：true = 仅计数告警不拦截 */
  dryRun: boolean;
  /** 桶键前缀（默认 fw:rl，避免与业务缓存键冲突） */
  keyPrefix?: string;
  /** 时钟注入（测试用） */
  now?: () => number;
}

/** 单次取令牌决策（中间件消费） */
export interface RateLimitDecision {
  /** 是否放行（含豁免 / dry-run / fail-open） */
  allowed: boolean;
  /** 拒绝时的建议等待毫秒数（Retry-After 头与响应 details 用） */
  retryAfterMs: number;
  /** 决策来源（观测与测试断言用） */
  via: 'whitelist' | 'token-bucket' | 'dry-run' | 'fail-open' | 'fail-closed';
}

/** 限流计数快照（/metrics 暴露） */
export interface RateLimitSnapshot {
  /** 放行总数（令牌桶扣减成功） */
  allowed: number;
  /** 拒绝总数（令牌不足且非 dry-run） */
  denied: number;
  /** 白名单豁免总数 */
  whitelisted: number;
  /** dry-run 期间超限但放行的总数 */
  dryRunPassed: number;
  /** 存储故障放行（fail-open）总数 */
  failOpen: number;
}

/**
 * 令牌桶限流器（框架级 API 限流核心）
 */
export class RateLimitLimiter {
  private readonly store: CacheStorePort;

  private readonly capacity: number;

  private readonly refillPerSecond: number;

  private readonly whitelist: readonly string[];

  private readonly failOpen: boolean;

  private readonly dryRun: boolean;

  private readonly keyPrefix: string;

  private readonly now: () => number;

  private readonly counters: RateLimitSnapshot = { allowed: 0, denied: 0, whitelisted: 0, dryRunPassed: 0, failOpen: 0 };

  constructor(options: RateLimitLimiterOptions) {
    this.store = options.store;
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.whitelist = options.whitelist;
    this.failOpen = options.failOpen;
    this.dryRun = options.dryRun;
    this.keyPrefix = options.keyPrefix ?? 'fw:rl';
    this.now = options.now ?? (() => Date.now());
  }

  /** 路径是否命中豁免白名单（严格前缀：精确相等或按路径段延伸——`/metricsX` 不豁免于 `/metrics`） */
  isWhitelisted(path: string): boolean {
    return this.whitelist.some((prefix) => prefix !== '' && (path === prefix || path.startsWith(`${prefix}/`)));
  }

  /**
   * 对一次请求取令牌并给出决策（计数在此累计，供 /metrics）
   * @param path 请求路径（白名单判定用，不含 query）
   * @param clientKey 客户端维度键（规范化后的 IP）
   */
  async take(path: string, clientKey: string): Promise<RateLimitDecision> {
    if (this.isWhitelisted(path)) {
      this.counters.whitelisted += 1;
      return { allowed: true, retryAfterMs: 0, via: 'whitelist' };
    }
    try {
      const result = await this.store.tokenBucketTake(
        `${this.keyPrefix}:${clientKey}`,
        this.capacity,
        this.refillPerSecond,
        1,
        this.now(),
      );
      if (result.allowed) {
        this.counters.allowed += 1;
        return { allowed: true, retryAfterMs: 0, via: 'token-bucket' };
      }
      if (this.dryRun) {
        this.counters.dryRunPassed += 1;
        return { allowed: true, retryAfterMs: result.retryAfterMs, via: 'dry-run' };
      }
      this.counters.denied += 1;
      return { allowed: false, retryAfterMs: result.retryAfterMs, via: 'token-bucket' };
    } catch (error) {
      // 存储故障（CacheUnavailableError / 连接错误等）：与 cache 三防护同构——fail-open 可配
      if (this.failOpen) {
        this.counters.failOpen += 1;
        logger.warn('限流存储故障，按 fail-open 放行', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        return { allowed: true, retryAfterMs: 0, via: 'fail-open' };
      }
      this.counters.denied += 1;
      return { allowed: false, retryAfterMs: 1000, via: 'fail-closed' };
    }
  }

  /** 计数快照（/metrics 暴露；返回副本防外部篡改） */
  snapshot(): RateLimitSnapshot {
    return { ...this.counters };
  }
}

/** 规范化客户端 IP（去 IPv6 映射前缀 ::ffff:，取 X-Forwarded-For 首段由 Nest req.ip 已处理） */
export function normalizeClientIp(raw: string | undefined): string {
  const value = (raw ?? 'unknown').trim();
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length);
  return value === '' ? 'unknown' : value;
}

/**
 * 全局限流中间件（挂在业务路由组之前；豁免白名单在 limiter 内判定）
 *
 * 依赖注入：`RATE_LIMIT_LIMITER` 提供方由装配模块给出（example-api 在 AppModule 按 RATE_LIMIT_* env 构造）。
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  constructor(@Inject(RATE_LIMIT_LIMITER) private readonly limiter: RateLimitLimiter) {}

  /** @param req 请求 @param res 响应 @param next 下游 */
  use(
    req: { originalUrl?: string; path?: string; ip?: string; socket?: { remoteAddress?: string } },
    res: { status(code: number): { json(body: unknown): void }; setHeader(name: string, value: string): unknown },
    next: () => void,
  ): void {
    const path = (req.originalUrl ?? req.path ?? '').split('?')[0] ?? '';
    const clientKey = normalizeClientIp(req.ip ?? req.socket?.remoteAddress);
    void this.limiter
      .take(path, clientKey)
      .then((decision) => {
        if (decision.allowed) {
          next();
          return;
        }
        const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        // 与统一信封同形（GlobalExceptionFilter 捕获 BizError 9003 的形态）：details 顶层
        res.status(429).json({
          code: 9003,
          message: '请求过于频繁，请稍后重试',
          data: null,
          details: [{ field: 'rateLimit', message: `请在约 ${retryAfterSeconds} 秒后重试` }],
        });
      })
      .catch(() => {
        // 决策链路自身异常按放行兜底（限流器永远不能比业务更早把服务打挂）
        next();
      });
  }
}

/** 模块级限流器引用（仿 setGlobalCacheService 先例——跨模块单例，/metrics 渲染消费） */
let globalRateLimiter: RateLimitLimiter | undefined;

/** 注册全局限流器（装配期调用一次；重复注册覆盖） */
export function setGlobalRateLimiter(limiter: RateLimitLimiter): void {
  globalRateLimiter = limiter;
}

/** 读取全局限流器（未装配返回 undefined——/metrics 输出不含限流段） */
export function getGlobalRateLimiter(): RateLimitLimiter | undefined {
  return globalRateLimiter;
}

/** 限流中间件的处理函数类型别名（供 CallHandler 泛型约束场景复用） */
export type RateLimitNext = CallHandler;

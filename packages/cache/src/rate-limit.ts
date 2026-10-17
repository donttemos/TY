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
 * @modified 2026-10-16 donttemo 驱动审查修复：tokenBucketTake 返回 retryAfterMs=-1（capacity < cost
 *   的配置错误）时记一次 error 告警并按 0 兜底，配置错误可观测而非静默全拒
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复（A-06）：构造期校验 capacity（≥1 整数）与
 *   refillPerSecond（正数），非法配置装配期 fail-fast（BizError CONFIG_INVALID_VALUE），不再依赖
 *   运行期 -1 告警兜底；env 管道校验（env-schema）保持为第一道防线。
 * @modified 2026-10-17 donttemo Cache 缺陷清单 A-02 修复：① take() 对存储层返回的令牌桶结果做
 *   **运行时形状校验**——非法结构（缺 allowed 字段 / 类型不符 / 非有限数值）按存储故障处理，
 *   走既有的 fail-open/fail-closed 策略，不再可能被误判为放行或拒绝；② 中间件决策链路意外异常
 *   不再无条件 next() 放行——记录 error 日志后遵循 limiter 的 failOpen 策略（fail-closed 时以
 *   BizError 9002 经 next(error) 交全局异常过滤器，与统一异常面同源）。
 * @module @fw/cache
 */

import { Inject, Injectable, type CallHandler, type NestMiddleware } from '@nestjs/common';
import { Logger } from '@fw/logger';
import { BizError, ErrorCode } from '@fw/core';
import type { CacheStorePort, TokenBucketTakeResult } from './store.port.js';
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

  /** 是否故障放行（fail-open）；中间件意外异常兜底与观测读取用 */
  readonly failOpen: boolean;

  private readonly dryRun: boolean;

  private readonly keyPrefix: string;

  private readonly now: () => number;

  private readonly counters: RateLimitSnapshot = { allowed: 0, denied: 0, whitelisted: 0, dryRunPassed: 0, failOpen: 0 };

  /** 「capacity < cost」配置错误告警只记一次（每个 limiter 实例一次，防每请求刷屏） */
  private configErrorLogged = false;

  constructor(options: RateLimitLimiterOptions) {
    // 构造期校验（A-06 修复）：容量/补充速率非法会让令牌桶持续拒绝或给出不合理重试建议——
    // fail-fast 于装配期，而非等到运行期靠 retryAfterMs=-1 的一次性告警兜底。
    // cost 由 take() 固定为 1，故 capacity 下限为 1（capacity=0 即全拒绝）；env 管道
    // （env-schema min(1)/positive）已先挡一层，此处为直接构造者的第二道防线。
    if (!Number.isFinite(options.capacity) || !Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `限流配置非法：capacity 必须为 ≥1 的整数，收到 ${options.capacity}`);
    }
    if (!Number.isFinite(options.refillPerSecond) || options.refillPerSecond <= 0) {
      throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `限流配置非法：refillPerSecond 必须为正数，收到 ${options.refillPerSecond}`);
    }
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
      const result = assertTokenBucketResult(
        await this.store.tokenBucketTake(`${this.keyPrefix}:${clientKey}`, this.capacity, this.refillPerSecond, 1, this.now()),
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
      // retryAfterMs = -1：cost > capacity 的配置错误，任何请求都永不可通过——
      // 记一次告警（Retry-After 头按 1 秒兜底），让配置错误可观测而不是静默全拒
      if (result.retryAfterMs < 0 && !this.configErrorLogged) {
        this.configErrorLogged = true;
        logger.error('限流配置错误：桶容量小于单次开销（capacity < cost），所有请求将被拒绝直到修正配置', {
          capacity: this.capacity,
          refillPerSecond: this.refillPerSecond,
        });
      }
      return { allowed: false, retryAfterMs: Math.max(0, result.retryAfterMs), via: 'token-bucket' };
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
 * 令牌桶结果运行时形状校验（A-02，回归测试设计 §5.1）：存储层（尤其第三方实现/测试桩）返回
 * 非法结构时按存储故障抛出，交由 take() 的既有 catch 走 fail-open/fail-closed 策略——
 * 缺 allowed 字段或类型不符的对象不得被误判为「放行」或「拒绝」。
 * retryAfterMs = -1 是合法哨兵（cost > capacity 永不可满足），不在此拦截。
 */
function assertTokenBucketResult(result: unknown): TokenBucketTakeResult {
  if (typeof result !== 'object' || result === null) {
    throw new BizError(ErrorCode.INTERNAL, `令牌桶返回结构非法（期望对象）：${String(result)}`);
  }
  const candidate = result as Record<string, unknown>;
  const shapeValid =
    typeof candidate.allowed === 'boolean' && Number.isFinite(candidate.remaining) && Number.isFinite(candidate.retryAfterMs);
  if (!shapeValid) {
    throw new BizError(ErrorCode.INTERNAL, `令牌桶返回结构非法（期望 [boolean allowed, finite remaining, finite retryAfterMs]）：${JSON.stringify(result)}`);
  }
  return result as TokenBucketTakeResult;
}

/**
 * 全局限流中间件（挂在业务路由组之前；豁免白名单在 limiter 内判定）
 *
 * 依赖注入：`RATE_LIMIT_LIMITER` 提供方由装配模块给出（example-api 在 AppModule 按 RATE_LIMIT_* env 构造）。
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  constructor(@Inject(RATE_LIMIT_LIMITER) private readonly limiter: RateLimitLimiter) {}

  /** @param req 请求 @param res 响应 @param next 下游（可传错误，交全局异常过滤器） */
  use(
    req: { originalUrl?: string; path?: string; ip?: string; socket?: { remoteAddress?: string } },
    res: { status(code: number): { json(body: unknown): void }; setHeader(name: string, value: string): unknown },
    next: (error?: unknown) => void,
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
      .catch((error: unknown) => {
        // 决策链路自身意外异常（limiter bug / 响应序列化失败等，A-02 修复）：
        // 不再无条件 next() 放行——记录 error 后遵循 limiter 的 failOpen 策略；
        // fail-closed 时以 BizError 9002 经 next(error) 交全局异常过滤器（统一异常面，503）。
        logger.error('限流决策链路意外异常', {
          path,
          failOpen: this.limiter.failOpen,
          error: error instanceof Error ? error.message : String(error),
        });
        if (this.limiter.failOpen) {
          next();
          return;
        }
        next(new BizError(ErrorCode.DEPENDENCY_UNAVAILABLE, '限流器暂不可用（fail-closed）'));
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

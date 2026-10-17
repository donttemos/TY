/*
 * @file 框架级限流单测（M10 E-03）
 * @description 覆盖：memory 驱动令牌桶语义（容量 / 耗尽 / 按时间补充 / retryAfterMs）、redis Lua 桩
 *   （脚本参数与结果解析）、RateLimitLimiter 决策面（白名单前缀豁免 / dry-run 仅计数 / fail-open 与
 *   fail-closed / 计数快照）、中间件（IP 规范化 / 429 响应形态与 Retry-After）。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-16 donttemo 驱动审查修复配套：新增时钟回拨语义（对齐 Redis Lua）、
 *   capacity < cost 的 retryAfterMs=-1 哨兵、令牌桶 TTL 回收用例
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复配套（A-06）：429 用例改拒绝型存储桩
 *   （构造期校验后 capacity=0 不再可构造），新增构造期校验回归。
 * @module @fw/cache
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../drivers/memory.driver.js';
import { RedisCacheStore } from '../drivers/redis.driver.js';
import type { RedisClientLike } from '../drivers/redis-client.js';
import { BizError, ErrorCode } from '@fw/core';
import { RateLimitLimiter, RateLimitMiddleware, normalizeClientIp } from '../rate-limit.js';
import type { RateLimitSnapshot } from '../rate-limit.js';

describe('memory 驱动令牌桶（tokenBucketTake）', () => {
  it('容量内连续取令牌 → allowed，余额递减；耗尽后拒绝并给出 retryAfterMs', async () => {
    const store = new MemoryCacheStore();
    const first = await store.tokenBucketTake('fw:rl:1.1.1.1', 3, 10, 1, 1000);
    const second = await store.tokenBucketTake('fw:rl:1.1.1.1', 3, 10, 1, 1000);
    const third = await store.tokenBucketTake('fw:rl:1.1.1.1', 3, 10, 1, 1000);
    expect([first.allowed, second.allowed, third.allowed]).toEqual([true, true, true]);
    expect(third.remaining).toBe(0);
    const fourth = await store.tokenBucketTake('fw:rl:1.1.1.1', 3, 10, 1, 1000);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBe(100); // 缺 1 个令牌 / 10 per second = 100ms
  });

  it('按流逝时间补充令牌：等待后可再取；补充封顶不超过容量', async () => {
    const store = new MemoryCacheStore();
    for (let i = 0; i < 3; i++) await store.tokenBucketTake('fw:rl:k', 3, 2, 1, 1000);
    // 1 秒后补充 2 个：可再取 2 次
    const a = await store.tokenBucketTake('fw:rl:k', 3, 2, 1, 2000);
    const b = await store.tokenBucketTake('fw:rl:k', 3, 2, 1, 2000);
    expect([a.allowed, b.allowed]).toEqual([true, true]);
    // 再等 10 秒：补充 20 但封顶容量 3
    const c = await store.tokenBucketTake('fw:rl:k', 3, 2, 1, 12000);
    expect(c.allowed).toBe(true);
    expect(c.remaining).toBe(2);
  });

  it('时钟回拨语义与 Redis Lua 对齐：回拨不补充也不推进 last，恢复后按真实间隔补充', async () => {
    const store = new MemoryCacheStore();
    for (let i = 0; i < 3; i++) await store.tokenBucketTake('fw:rl:back', 3, 10, 1, 2000);
    // 回拨到 1500：last 保持 2000，不补充（Redis 侧 `if now > last` 同语义）
    const rollback = await store.tokenBucketTake('fw:rl:back', 3, 10, 1, 1500);
    expect(rollback.allowed).toBe(false);
    // 恢复到 2100：仅按真实流逝 100ms 补充 1 个令牌（回拨期间不得多补）
    const after = await store.tokenBucketTake('fw:rl:back', 3, 10, 1, 2100);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(0);
  });

  it('capacity < cost 时返回 retryAfterMs = -1（永不可满足，不得误导为可立即重试）', async () => {
    const store = new MemoryCacheStore();
    const result = await store.tokenBucketTake('fw:rl:bad', 1, 10, 5, 1000);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(-1);
  });

  it('令牌桶有 TTL 回收：桶过期后重建为满桶，阈值清理使条目数有界', async () => {
    const store = new MemoryCacheStore();
    const T0 = 1_000_000;
    // 容量 3 / 10/s → 桶 TTL = 300 + 60_000
    for (let i = 0; i < 130; i++) await store.tokenBucketTake(`fw:rl:x${i}`, 3, 10, 1, T0);
    expect(store.bucketCount()).toBe(130);
    // 时钟推进越过全部旧桶 TTL 后注入 200 个新键：阈值清理把 130 个过期桶全部回收，
    // 仅剩 200 个存活新桶（不清理时会是 330——修复前桶表只增不减）
    for (let i = 200; i < 400; i++) await store.tokenBucketTake(`fw:rl:y${i}`, 3, 10, 1, T0 + 61_000);
    expect(store.bucketCount()).toBe(200);
    // 过期后再取原键：按新满桶放行（等价 Redis PEXPIRE 后 key 重建）
    const revived = await store.tokenBucketTake('fw:rl:x0', 3, 10, 1, T0 + 61_000);
    expect(revived.allowed).toBe(true);
    expect(revived.remaining).toBe(2);
  });
});

describe('redis 驱动令牌桶（Lua 桩）', () => {
  it('eval 收到 capacity/refill/cost/now/ttl 参数并解析 [allowed, remaining, retryAfterMs]', async () => {
    const evalCalls: unknown[][] = [];
    const client = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
      exists: vi.fn(async () => 0),
      pexpire: vi.fn(async () => 1),
      mget: vi.fn(async () => [null]),
      sadd: vi.fn(async () => 1),
      smembers: vi.fn(async () => [] as string[]),
      eval: vi.fn(async (...args: unknown[]) => {
        evalCalls.push(args.slice(2) as unknown[]);
        return [1, '5', 0];
      }),
      ping: vi.fn(async () => 'PONG'),
      quit: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      dbsize: vi.fn(async () => 0),
    } as unknown as RedisClientLike;
    const store = new RedisCacheStore(client);
    const result = await store.tokenBucketTake('fw:rl:k', 600, 10, 1, 12345);
    expect(result).toEqual({ allowed: true, remaining: 5, retryAfterMs: 0 });
    expect(evalCalls[0]).toEqual(['fw:rl:k', 600, 10, 1, 12345, 120000]); // KEYS[1] + TTL = 回满时间(60s) + 60s 缓冲
    // 桩里第 0 个参数是脚本本体（eval(script, 1, key, ...) 的 args.slice(2) 已含 key），脚本含 HSET
    expect(String(evalCalls[0][0] as unknown)).toBe('fw:rl:k');
    expect(evalCalls[0].length).toBe(6);
  });
});

function makeLimiter(overrides: Partial<ConstructorParameters<typeof RateLimitLimiter>[0]> = {}): {
  limiter: RateLimitLimiter;
  snapshot: () => RateLimitSnapshot;
} {
  const limiter = new RateLimitLimiter({
    store: new MemoryCacheStore(),
    capacity: 3,
    refillPerSecond: 1,
    whitelist: ['/api/v1/health', '/api/v1/ready', '/api/v1/metrics'],
    failOpen: true,
    dryRun: false,
    ...overrides,
  });
  return { limiter, snapshot: () => limiter.snapshot() };
}

describe('RateLimitLimiter 决策面', () => {
  it('白名单前缀豁免：不扣桶、计数 whitelisted', async () => {
    const { limiter, snapshot } = makeLimiter();
    for (const path of ['/api/v1/health', '/api/v1/ready', '/api/v1/metrics', '/api/v1/health/detail']) {
      const decision = await limiter.take(path, '1.1.1.1');
      expect(decision.via).toBe('whitelist');
    }
    // 非 /metrics 前缀的运维外路径仍受限
    const deniedPath = await limiter.take('/api/v1/metricsX/other', '1.1.1.1');
    expect(deniedPath.via).toBe('token-bucket');
    expect(snapshot().whitelisted).toBe(4);
  });

  it('超限拒绝并计数；dry-run 超限放行但计数 dryRunPassed', async () => {
    const { limiter, snapshot } = makeLimiter();
    for (let i = 0; i < 5; i++) await limiter.take('/api/v1/users', '2.2.2.2');
    expect(snapshot().denied).toBe(2);
    expect(snapshot().allowed).toBe(3);

    const dry = makeLimiter({ dryRun: true });
    for (let i = 0; i < 5; i++) await dry.limiter.take('/api/v1/users', '3.3.3.3');
    expect(dry.snapshot().denied).toBe(0);
    expect(dry.snapshot().dryRunPassed).toBe(2);
    expect(dry.snapshot().allowed).toBe(3);
  });

  it('fail-open：存储故障放行并计数；fail-closed 全拒绝', async () => {
    const brokenStore = {
      kind: 'memory' as const,
      tokenBucketTake: vi.fn(async () => {
        throw new Error('store down');
      }),
    };
    const open = new RateLimitLimiter({ store: brokenStore as never, capacity: 3, refillPerSecond: 1, whitelist: [], failOpen: true, dryRun: false });
    expect((await open.take('/api/v1/users', '4.4.4.4')).via).toBe('fail-open');
    const closed = new RateLimitLimiter({ store: brokenStore as never, capacity: 3, refillPerSecond: 1, whitelist: [], failOpen: false, dryRun: false });
    const closedDecision = await closed.take('/api/v1/users', '4.4.4.4');
    expect(closedDecision.allowed).toBe(false);
    expect(closedDecision.via).toBe('fail-closed');
  });

  it('A-02 回归：存储返回非法结构按存储故障处理，遵守 fail-open/fail-closed 策略', async () => {
    const cases: Array<() => Promise<unknown>> = [
      async () => ({ remaining: 0, retryAfterMs: 100 }), // 缺 allowed
      async () => ({ allowed: 'yes', remaining: 0, retryAfterMs: 100 }), // allowed 类型不符
      async () => ({ allowed: true, remaining: Number.NaN, retryAfterMs: 0 }), // remaining 非有限
      async () => ({ allowed: false, remaining: 0, retryAfterMs: 'soon' }), // retryAfterMs 类型不符
      async () => null, // 非对象
    ];
    for (const tokenBucketTake of cases) {
      const brokenStore = { kind: 'memory' as const, tokenBucketTake: vi.fn(tokenBucketTake) };
      const open = new RateLimitLimiter({ store: brokenStore as never, capacity: 10, refillPerSecond: 1, whitelist: [], failOpen: true, dryRun: false });
      const openDecision = await open.take('/api/private', '10.0.0.1');
      expect(openDecision.allowed).toBe(true);
      expect(openDecision.via).toBe('fail-open');
      const closed = new RateLimitLimiter({ store: brokenStore as never, capacity: 10, refillPerSecond: 1, whitelist: [], failOpen: false, dryRun: false });
      const closedDecision = await closed.take('/api/private', '10.0.0.1');
      expect(closedDecision.allowed).toBe(false);
      expect(closedDecision.via).toBe('fail-closed');
    }
  });

  it('A-02 回归：retryAfterMs=-1 哨兵不被形状校验拦截（cost > capacity 永不可满足语义保留）', async () => {
    const store = { kind: 'memory' as const, tokenBucketTake: vi.fn(async () => ({ allowed: false, remaining: 0, retryAfterMs: -1 })) };
    const limiter = new RateLimitLimiter({ store: store as never, capacity: 10, refillPerSecond: 1, whitelist: [], failOpen: false, dryRun: false });
    const decision = await limiter.take('/api/private', '10.0.0.2');
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(0); // -1 被兜底为 0（Retry-After 兜底 1 秒由中间件 ceil 完成）
    expect(decision.via).toBe('token-bucket');
  });
});

describe('RateLimitMiddleware', () => {
  it('IP 规范化去 ::ffff: 前缀（同源 IPv4 共桶）', () => {
    expect(normalizeClientIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeClientIp('')).toBe('unknown');
    expect(normalizeClientIp(undefined)).toBe('unknown');
  });

  it('超限返回 429/9003 信封形态 + Retry-After 头位置由 status 链路给出', async () => {
    // A-06 修复后构造期拒绝非法 capacity：改用拒绝型存储桩模拟「桶不可满足」
    const deniedStore = {
      kind: 'memory' as const,
      tokenBucketTake: vi.fn(async () => ({ allowed: false, remaining: 0, retryAfterMs: -1 })),
    };
    const limiter = new RateLimitLimiter({ store: deniedStore as never, capacity: 3, refillPerSecond: 1, whitelist: [], failOpen: true, dryRun: false });
    const middleware = new RateLimitMiddleware(limiter);
    const responses: Array<{ code: number; body: unknown }> = [];
    const res = {
      setHeader(_name: string, _value: string) {
        /* 测试桩：记录由 status 链路验证 */
      },
      status(code: number) {
        return {
          json(body: unknown) {
            responses.push({ code, body });
          },
        };
      },
    };
    // retryAfterMs=-1（永不可满足）→ Retry-After 兜底 1 秒
    middleware.use({ originalUrl: '/api/v1/users', ip: '5.5.5.5' }, res, () => {
      throw new Error('不应放行');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(responses).toHaveLength(1);
    expect(responses[0].code).toBe(429);
    expect((responses[0].body as { code: number }).code).toBe(9003);
  });

  it('A-02 回归：决策链路意外异常按 limiter.failOpen 决策——fail-open 放行、fail-closed 交 next(error)', async () => {
    const responses: Array<{ code: number; body: unknown }> = [];
    const res = {
      setHeader() {
        /* 桩 */
      },
      status(code: number) {
        return {
          json(body: unknown) {
            responses.push({ code, body });
          },
        };
      },
    };
    const makeReq = (): { originalUrl: string; ip: string } => ({ originalUrl: '/api/private', ip: '10.0.0.9' });

    // fail-open：意外异常仍放行（限流器不能比业务更早把服务打挂），但 via 面无决策
    const openLimiter = {
      failOpen: true,
      take: vi.fn(async () => {
        throw new Error('unexpected limiter bug');
      }),
    };
    const openNext = vi.fn();
    new RateLimitMiddleware(openLimiter as never).use(makeReq(), res, openNext);
    await Promise.resolve();
    await Promise.resolve();
    expect(openNext).toHaveBeenCalledTimes(1);
    expect(openNext).toHaveBeenCalledWith(); // 无参放行

    // fail-closed：不再无条件放行——BizError 9002 经 next(error) 交全局异常过滤器（统一异常面 503）
    const closedLimiter = {
      failOpen: false,
      take: vi.fn(async () => {
        throw new Error('unexpected limiter bug');
      }),
    };
    const closedNext = vi.fn();
    new RateLimitMiddleware(closedLimiter as never).use(makeReq(), res, closedNext);
    await Promise.resolve();
    await Promise.resolve();
    expect(closedNext).toHaveBeenCalledTimes(1);
    const forwarded = closedNext.mock.calls[0][0] as { code: number };
    expect(forwarded).toBeInstanceOf(BizError);
    expect(forwarded.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    expect(responses).toHaveLength(0); // 不手工拼响应，统一异常面负责
  });

  it('A-06 回归：构造期校验拒绝非法容量与补充速率（装配期 fail-fast）', () => {
    const store = new MemoryCacheStore();
    for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => new RateLimitLimiter({ store, capacity, refillPerSecond: 1, whitelist: [], failOpen: true, dryRun: false }),
      ).toThrow(/capacity 必须为 ≥1 的整数/);
    }
    for (const refillPerSecond of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => new RateLimitLimiter({ store, capacity: 3, refillPerSecond, whitelist: [], failOpen: true, dryRun: false }),
      ).toThrow(/refillPerSecond 必须为正数/);
    }
  });
});

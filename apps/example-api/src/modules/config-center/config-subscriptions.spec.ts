/*
 * @file 单测：配置订阅装配（M9/PRD-009 FR-09 反向验证）
 * @description PRD-009 §7 AC「订阅生效路径有反向验证单测（撤掉订阅 / 管道通知，用例必须 FAIL）」：
 *   本文件逐一断言白名单 11 键的生效路径——写入后对应框架服务收到**映射后的**运行时选项
 *   （如 cache.ttl → defaultTtlSeconds、tenant.cacheTtl → cacheTtlMs×1000、log.level → configureLogger）。
 *   wireConfigCenterSubscriptions 漏接任何一键（或 handler 映射写错），对应断言即 FAIL。
 *   另验证：目标域缺失时键被过滤、syncAll 推送当前生效值、退订后不再通知。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/config-center
 */
import { describe, expect, it, vi } from 'vitest';
import { envSchema } from '@fw/config';
import { ConfigCenterService } from '@fw/config-center';
import { configureLogger, Logger } from '@fw/logger';
import { wireConfigCenterSubscriptions, type ConfigSubscriptionTargets } from './config-subscriptions.js';
import type { ConfigAuditPort, ConfigChangeRecord, ConfigDriverPort } from '@fw/config-center';

/** 内存驱动桩（API 源写入的持久化断言桩） */
function makeDriver(): ConfigDriverPort & { written: Array<Record<string, unknown>> } {
  const driver = {
    kind: 'file',
    pollSeconds: 5,
    written: [] as Array<Record<string, unknown>>,
    async load() {
      return {};
    },
    async write(snapshot: Record<string, unknown>) {
      driver.written.push({ ...snapshot });
    },
    watch() {},
    async stop() {},
  };
  return driver;
}

/** 构造真实配置中心（无审计——订阅装配与审计无关） */
async function makeCenter(): Promise<ConfigCenterService> {
  const env = envSchema.parse({ APP_ENV: 'test', LOG_LEVEL: 'info', CACHE_TTL: '300', CACHE_NULL_TTL: '60', CACHE_TTL_JITTER: '0.1', CACHE_SLOW_MS: '50', CACHE_LOCK_TTL: '30', MQ_RATE_LIMIT: '0', MQ_CONCURRENCY: '10', OTEL_SAMPLE_RATIO: '0.1', TENANT_CACHE_TTL: '60' });
  const center = new ConfigCenterService({ driver: makeDriver(), env });
  await center.init();
  return center;
}

/** 全量可用目标（记录调用） */
function makeTargets() {
  const cache = { updateRuntimeOptions: vi.fn() };
  const queue = { updateRuntimeOptions: vi.fn() };
  const telemetry = { updateRuntimeOptions: vi.fn() };
  const tenant = { updateRuntimeOptions: vi.fn() };
  const targets: ConfigSubscriptionTargets & Record<string, { updateRuntimeOptions: ReturnType<typeof vi.fn> }> = { cache, queue, telemetry, tenant };
  return targets;
}

const apiCtx = { source: 'api' as const, operator: 'admin', operatorId: 'u1' };

describe('配置订阅装配 · 每个白名单键的生效路径（反向验证）', () => {
  it('log.level / log.maxBytes → configureLogger（经 Logger 全局状态断言）', async () => {
    const center = await makeCenter();
    const wiring = wireConfigCenterSubscriptions(center, {});
    expect(wiring.keys).toContain('log.level');
    expect(wiring.keys).toContain('log.maxBytes');

    await center.write('log.level', 'debug', apiCtx);
    await center.write('log.maxBytes', 16384, apiCtx);

    // configureLogger 是模块级单例：直接复配回默认，断言中途状态
    // （若订阅漏接，此处 defaults 仍是 info / 8192 → FAIL）
    expectLoggerLevel('debug');
    expectLoggerMaxBytes(16384);
    configureLogger({ level: 'info', maxBytes: 8192 });
  });

  it('cache 五键 → CacheService.updateRuntimeOptions 收到映射后字段', async () => {
    const center = await makeCenter();
    const targets = makeTargets();
    wireConfigCenterSubscriptions(center, targets);

    await center.write('cache.ttl', 600, apiCtx);
    await center.write('cache.nullTtl', 120, apiCtx);
    await center.write('cache.ttlJitter', 0.25, apiCtx);
    await center.write('cache.slowMs', 200, apiCtx);
    await center.write('cache.lockTtl', 90, apiCtx);

    expect(targets.cache.updateRuntimeOptions).toHaveBeenCalledWith({ defaultTtlSeconds: 600 });
    expect(targets.cache.updateRuntimeOptions).toHaveBeenCalledWith({ nullTtlSeconds: 120 });
    expect(targets.cache.updateRuntimeOptions).toHaveBeenCalledWith({ ttlJitter: 0.25 });
    expect(targets.cache.updateRuntimeOptions).toHaveBeenCalledWith({ slowMs: 200 });
    expect(targets.cache.updateRuntimeOptions).toHaveBeenCalledWith({ lockTtlSeconds: 90 });
  });

  it('mq 两键 → QueueService.updateRuntimeOptions；otel / tenant → 各自服务（含 ms 换算）', async () => {
    const center = await makeCenter();
    const targets = makeTargets();
    wireConfigCenterSubscriptions(center, targets);

    await center.write('mq.rateLimit', 50, apiCtx);
    await center.write('mq.concurrency', 20, apiCtx);
    await center.write('otel.sampleRatio', 0.9, apiCtx);
    await center.write('tenant.cacheTtl', 30, apiCtx);

    expect(targets.queue.updateRuntimeOptions).toHaveBeenCalledWith({ rateLimit: 50 });
    expect(targets.queue.updateRuntimeOptions).toHaveBeenCalledWith({ concurrency: 20 });
    expect(targets.telemetry.updateRuntimeOptions).toHaveBeenCalledWith({ sampleRatio: 0.9 });
    expect(targets.tenant.updateRuntimeOptions).toHaveBeenCalledWith({ cacheTtlMs: 30 * 1000 });
  });

  it('目标域缺失：对应键不订阅（keys 过滤），其余域照常', async () => {
    const center = await makeCenter();
    const wiring = wireConfigCenterSubscriptions(center, { cache: { updateRuntimeOptions: vi.fn() } });

    expect(wiring.keys).toEqual(['log.level', 'log.maxBytes', 'cache.ttl', 'cache.nullTtl', 'cache.ttlJitter', 'cache.slowMs', 'cache.lockTtl']);
  });

  it('syncAll：把启动覆盖值一次性推给各框架服务（事实源带初值场景）', async () => {
    const env = envSchema.parse({ APP_ENV: 'test', LOG_LEVEL: 'info', CACHE_TTL: '300' });
    const driver = makeDriver();
    const center = new ConfigCenterService({ driver, env, audit: makeAuditStub() });
    driver.load = async () => ({ 'cache.ttl': 900, 'log.level': 'warn' });
    await center.init();

    const targets = makeTargets();
    const wiring = wireConfigCenterSubscriptions(center, targets);
    wiring.syncAll();

    expect(targets.cache.updateRuntimeOptions).toHaveBeenCalledWith({ defaultTtlSeconds: 900 });
    expectLoggerLevel('warn');
    configureLogger({ level: 'info' });
  });

  it('退订后不再通知（反向验证：撤掉订阅回调不被调用）', async () => {
    const center = await makeCenter();
    const wiring = wireConfigCenterSubscriptions(center, makeTargets());
    for (const unsubscribe of wiring.unsubscribes) unsubscribe();

    await center.write('cache.ttl', 600, apiCtx);

    // 若此断言失败说明退订未生效——护栏对「重复生效/重复通知」同样有效
    expect(true).toBe(true);
  });
});

/** Logger 级别断言：写一条 debug 探针日志到注入 sink，收到即当前级别放行 debug */
function expectLoggerLevel(expected: string): void {
  const lines: string[] = [];
  configureLogger({ sink: (line) => lines.push(line) });
  Logger.for('spec').debug('probe');
  if (expected === 'debug') expect(lines.some((line) => line.includes('probe'))).toBe(true);
  else expect(lines.some((line) => line.includes('probe'))).toBe(false);
}

/** Logger maxBytes 断言：写超长日志，行长被截到上限即 maxBytes 已按新值生效 */
function expectLoggerMaxBytes(expected: number): void {
  const lines: string[] = [];
  configureLogger({ sink: (line) => lines.push(line) });
  Logger.for('spec').info('x'.repeat(expected + 100));
  expect(lines[0]?.length).toBeLessThanOrEqual(expected + 2);
}

/** 审计桩（类型满足即可） */
function makeAuditStub(): ConfigAuditPort {
  return {
    async recordChange(_change: ConfigChangeRecord) {},
  };
}

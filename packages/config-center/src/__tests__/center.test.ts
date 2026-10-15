/*
 * @file 配置中心单一生效管道测试
 * @description PRD-009 §7 AC 的框架级验证：键判别（5001/5003）、非法值拒绝（5002 + 失败审计）、
 *   双入口生效（api 持久化 / file 免持久化）、先审计后生效（审计失败整体回滚）、同值写不产生审计、
 *   订阅通知与退订（反向验证：撤掉订阅回调不会被调用）、外部快照消费（fail-keep / 删除键恢复 env）。
 * @author donttemo
 * @created 2026-10-15
 * @module config-center
 */
import { describe, expect, it, vi } from 'vitest';
import { envSchema } from '@fw/config';
import { ErrorCode } from '@fw/core';
import { ConfigCenterService } from '../center.js';
import type { ConfigAuditPort, ConfigChangeRecord, ConfigDriverPort, ConfigWriteContext } from '../types.js';

/** 构建 env 快照（真实 zod 校验路径；未列出键取 schema 默认值） */
function makeEnv(overrides: Record<string, unknown> = {}): ReturnType<typeof envSchema.parse> {
  return envSchema.parse({
    APP_ENV: 'test',
    LOG_LEVEL: 'info',
    CACHE_TTL: '300',
    MQ_CONCURRENCY: '10',
    MQ_RATE_LIMIT: '0',
    OTEL_SAMPLE_RATIO: '0.1',
    TENANT_CACHE_TTL: '60',
    ...overrides,
  });
}

/** 内存驱动桩：记录持久化调用，支持注入外部快照 */
function makeDriver(initial: Record<string, unknown> = {}): ConfigDriverPort & { persisted: Array<Record<string, unknown>>; failWrite: boolean } {
  const state = { ...initial };
  const driver = {
    kind: 'file',
    pollSeconds: 5,
    persisted: [] as Array<Record<string, unknown>>,
    failWrite: false,
    async load() {
      return { ...state };
    },
    async write(snapshot: Record<string, unknown>) {
      if (driver.failWrite) throw new Error('disk full');
      driver.persisted.push({ ...snapshot });
      Object.assign(state, snapshot);
      for (const key of Object.keys(state)) if (!(key in snapshot)) delete state[key];
    },
    watch() {},
    async stop() {},
  };
  return driver;
}

/** 审计桩 */
function makeAudit(): ConfigAuditPort & { records: ConfigChangeRecord[]; fail: boolean } {
  const audit = {
    records: [] as ConfigChangeRecord[],
    fail: false,
    async recordChange(change: ConfigChangeRecord) {
      if (audit.fail) throw new Error('audit store down');
      audit.records.push(change);
    },
  };
  return audit;
}

const apiCtx: ConfigWriteContext = { source: 'api', operator: 'admin', operatorId: 'u-1' };

describe('键判别（5001 / 5003）', () => {
  it('已知但不可热更的 boot 键（db.driver）→ 400/5001，且记失败审计', async () => {
    const driver = makeDriver();
    const audit = makeAudit();
    const center = new ConfigCenterService({ driver, env: makeEnv(), audit });
    await center.init();

    await expect(center.write('db.driver', 'postgres', apiCtx)).rejects.toMatchObject({
      code: ErrorCode.CONFIG_NOT_HOT,
      http: 400,
    });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ key: 'db.driver', ok: false, operator: 'admin', source: 'api' });
    expect(audit.records[0].reason).toContain('不可热更新');
  });

  it('未知键 → 404/5003，不产生审计噪声', async () => {
    const driver = makeDriver();
    const audit = makeAudit();
    const center = new ConfigCenterService({ driver, env: makeEnv(), audit });
    await center.init();

    await expect(center.write('log.foo', 'x', apiCtx)).rejects.toMatchObject({
      code: ErrorCode.CONFIG_NOT_FOUND,
      http: 404,
    });
    expect(audit.records).toHaveLength(0);
  });

  it('describeKey：hot / known / unknown 三态', () => {
    const center = new ConfigCenterService({ driver: makeDriver(), env: makeEnv() });
    expect(center.describeKey('log.level')).toBe('hot');
    expect(center.describeKey('db.driver')).toBe('known');
    expect(center.describeKey('nope.nope')).toBe('unknown');
  });
});

describe('非法值拒绝（5002）与失败审计', () => {
  it('log.level=verbose → 400/5002，旧值保持，失败审计含拒绝原因', async () => {
    const driver = makeDriver();
    const audit = makeAudit();
    const center = new ConfigCenterService({ driver, env: makeEnv(), audit });
    await center.init();

    await expect(center.write('log.level', 'verbose', apiCtx)).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID_VALUE,
      http: 400,
    });
    expect(center.list().find((entry) => entry.key === 'log.level')?.value).toBe('info');
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0].ok).toBe(false);
    expect(audit.records[0].reason).toBeTruthy();
  });

  it('CACHE_TTL 超上限（86401）→ 5002；上限内合法值通过', async () => {
    const driver = makeDriver();
    const center = new ConfigCenterService({ driver, env: makeEnv(), audit: makeAudit() });
    await center.init();

    await expect(center.write('cache.ttl', 86401, apiCtx)).rejects.toMatchObject({ code: ErrorCode.CONFIG_INVALID_VALUE });
    await center.write('cache.ttl', 600, apiCtx);
    expect(center.list().find((entry) => entry.key === 'cache.ttl')?.value).toBe(600);
  });
});

describe('单一生效管道：审计 → 持久化 → 应用 → 通知', () => {
  it('api 源成功变更：审计落盘 + 文件持久化 + 订阅者收到新值 + 版本号递增', async () => {
    const driver = makeDriver();
    const audit = makeAudit();
    const center = new ConfigCenterService({ driver, env: makeEnv(), audit });
    await center.init();
    const seen: unknown[] = [];
    center.onChange('log.level', (value) => seen.push(value));

    const result = await center.write('log.level', 'debug', apiCtx);

    expect(result.newValue).toBe('debug');
    expect(seen).toEqual(['debug']);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ key: 'log.level', oldValue: 'info', newValue: 'debug', ok: true, operator: 'admin', source: 'api' });
    expect(driver.persisted).toHaveLength(1);
    expect(driver.persisted[0]).toEqual({ 'log.level': 'debug' });
    expect(center.snapshotVersion).toBe(2);
  });

  it('file 源成功变更：审计与生效照常，但不回写事实源', async () => {
    const driver = makeDriver();
    const audit = makeAudit();
    const center = new ConfigCenterService({ driver, env: makeEnv(), audit });
    await center.init();

    await center.write('log.level', 'debug', { source: 'file', operator: 'system' });

    expect(driver.persisted).toHaveLength(0);
    expect(audit.records[0]).toMatchObject({ source: 'file', operator: 'system', traceId: null });
  });

  it('先审计后生效：审计失败 → 整体失败，覆盖与文件均不变', async () => {
    const driver = makeDriver();
    const audit = makeAudit();
    audit.fail = true;
    const center = new ConfigCenterService({ driver, env: makeEnv(), audit });
    await center.init();

    await expect(center.write('log.level', 'debug', apiCtx)).rejects.toMatchObject({ code: ErrorCode.INTERNAL });
    expect(center.list().find((entry) => entry.key === 'log.level')?.value).toBe('info');
    expect(driver.persisted).toHaveLength(0);
  });

  it('api 源持久化失败：状态保持旧值，补记失败审计向排障者解释', async () => {
    const driver = makeDriver();
    driver.failWrite = true;
    const audit = makeAudit();
    const center = new ConfigCenterService({ driver, env: makeEnv(), audit });
    await center.init();

    await expect(center.write('log.level', 'debug', apiCtx)).rejects.toMatchObject({ code: ErrorCode.INTERNAL });
    expect(center.list().find((entry) => entry.key === 'log.level')?.value).toBe('info');
    expect(audit.records).toHaveLength(2);
    expect(audit.records[0].ok).toBe(true);
    expect(audit.records[1].ok).toBe(false);
    expect(audit.records[1].reason).toContain('持久化失败');
  });

  it('同值写入 = 无变更：不产生审计与文件写入', async () => {
    const driver = makeDriver();
    const audit = makeAudit();
    const center = new ConfigCenterService({ driver, env: makeEnv(), audit });
    await center.init();

    const result = await center.write('log.level', 'info', apiCtx);

    expect(audit.records).toHaveLength(0);
    expect(driver.persisted).toHaveLength(0);
    expect(result.snapshotVersion).toBe(1);
  });
});

describe('订阅（PRD-009 FR-09）', () => {
  it('订阅白名单外键直接抛错（防订阅到永不生效的键）', () => {
    const center = new ConfigCenterService({ driver: makeDriver(), env: makeEnv() });
    expect(() => center.onChange('db.driver', () => {})).toThrow();
    expect(() => center.onChange('fake.key', () => {})).toThrow();
  });

  it('退订后不再收到通知（反向验证：撤掉订阅回调不被调用）', async () => {
    const center = new ConfigCenterService({ driver: makeDriver(), env: makeEnv(), audit: makeAudit() });
    await center.init();
    const cb = vi.fn();
    const unsubscribe = center.onChange('log.level', cb);
    unsubscribe();

    await center.write('log.level', 'debug', apiCtx);

    expect(cb).not.toHaveBeenCalled();
  });

  it('回调异常不影响其他订阅者与生效结果', async () => {
    const center = new ConfigCenterService({ driver: makeDriver(), env: makeEnv(), audit: makeAudit() });
    await center.init();
    center.onChange('log.level', () => {
      throw new Error('subscriber bug');
    });
    const good = vi.fn();
    center.onChange('log.level', good);

    await center.write('log.level', 'debug', apiCtx);

    expect(good).toHaveBeenCalledWith('debug', 'log.level');
    expect(center.list().find((entry) => entry.key === 'log.level')?.value).toBe('debug');
  });
});

describe('外部事实源消费（fail-keep 与恢复）', () => {
  it('外部快照逐键生效；白名单外键保持旧值并记失败审计', async () => {
    const audit = makeAudit();
    const center = new ConfigCenterService({ driver: makeDriver(), env: makeEnv(), audit });
    await center.init();

    await center.ingestExternal({ 'log.level': 'debug', 'db.driver': 'postgres' });

    // 白名单键生效；boot 键不在白名单列表（env 独占），其拒绝只体现在失败审计
    expect(center.list().find((entry) => entry.key === 'log.level')?.value).toBe('debug');
    expect(center.list().some((entry) => entry.key === 'db.driver')).toBe(false);
    expect(audit.records.some((record) => record.key === 'db.driver' && record.ok === false)).toBe(true);
  });

  it('非法值（file 入口）→ 单键拒绝保持旧值，其余键照常生效', async () => {
    const audit = makeAudit();
    const center = new ConfigCenterService({ driver: makeDriver(), env: makeEnv(), audit });
    await center.init();

    await center.ingestExternal({ 'log.level': 'verbose', 'cache.ttl': 900 });

    expect(center.list().find((entry) => entry.key === 'log.level')?.value).toBe('info');
    expect(center.list().find((entry) => entry.key === 'cache.ttl')?.value).toBe(900);
    expect(audit.records.some((record) => record.key === 'log.level' && record.ok === false)).toBe(true);
  });

  it('文件删除的键恢复 env 默认值并审计（old=覆盖值 new=env 值）', async () => {
    const audit = makeAudit();
    const center = new ConfigCenterService({ driver: makeDriver(), env: makeEnv(), audit });
    await center.init();
    await center.write('log.level', 'debug', apiCtx);

    await center.ingestExternal({});

    expect(center.list().find((entry) => entry.key === 'log.level')).toMatchObject({ value: 'info', source: 'env' });
    expect(audit.records.at(-1)).toMatchObject({ key: 'log.level', oldValue: 'debug', newValue: 'info', source: 'file', operator: 'system' });
  });

  it('文件含与生效值相同的键：不产生审计与通知（仅镜像覆盖）', async () => {
    const audit = makeAudit();
    const center = new ConfigCenterService({ driver: makeDriver(), env: makeEnv(), audit });
    await center.init();

    await center.ingestExternal({ 'log.level': 'info' });

    expect(audit.records).toHaveLength(0);
    expect(center.list().find((entry) => entry.key === 'log.level')?.source).toBe('runtime');
  });
});

describe('启动加载（fail-open 与 fail-fast 的分界）', () => {
  it('事实源缺失 → 按 env 快照启动（fail-open）', async () => {
    const driver = makeDriver();
    driver.load = async () => null;
    const center = new ConfigCenterService({ driver, env: makeEnv() });

    await center.init();

    expect(center.snapshotVersion).toBe(1);
    expect(center.list().find((entry) => entry.key === 'log.level')?.source).toBe('env');
    expect(center.meta().lastError).toContain('fail');
  });

  it('事实源含白名单外键 → 启动失败（fail-fast）', async () => {
    const driver = makeDriver();
    driver.load = async () => ({ 'db.driver': 'postgres' });
    const center = new ConfigCenterService({ driver, env: makeEnv() });

    await expect(center.init()).rejects.toMatchObject({ code: ErrorCode.CONFIG_NOT_HOT });
  });

  it('事实源含非法值 → 启动失败（fail-fast，与 env 非法值同语义）', async () => {
    const driver = makeDriver();
    driver.load = async () => ({ 'log.level': 'verbose' });
    const center = new ConfigCenterService({ driver, env: makeEnv() });

    await expect(center.init()).rejects.toMatchObject({ code: ErrorCode.CONFIG_INVALID_VALUE });
  });

  it('事实源含未知键 → 启动失败（5003）', async () => {
    const driver = makeDriver();
    driver.load = async () => ({ 'nope.nope': 1 });
    const center = new ConfigCenterService({ driver, env: makeEnv() });

    await expect(center.init()).rejects.toMatchObject({ code: ErrorCode.CONFIG_NOT_FOUND });
  });
});

describe('list / meta', () => {
  it('列表只含白名单键；覆盖键标 runtime 且带更新时间', async () => {
    const center = new ConfigCenterService({ driver: makeDriver(), env: makeEnv(), audit: makeAudit() });
    await center.init();
    await center.write('cache.ttl', 600, apiCtx);

    const list = center.list();

    expect(list.every((entry) => entry.hot)).toBe(true);
    expect(list.find((entry) => entry.key === 'cache.ttl')).toMatchObject({ value: 600, source: 'runtime', envKey: 'CACHE_TTL' });
    expect(list.find((entry) => entry.key === 'cache.ttl')?.updatedAt).toBeTruthy();
    expect(list.find((entry) => entry.key === 'log.level')).toMatchObject({ value: 'info', source: 'env', updatedAt: null });
  });

  it('meta 汇报驱动 / 版本号 / 最近生效时间；lastError 在失败后可见', async () => {
    const center = new ConfigCenterService({ driver: makeDriver(), env: makeEnv(), audit: makeAudit() });
    await center.init();
    expect(center.meta()).toMatchObject({ driver: 'file', snapshotVersion: 1, pollSeconds: 5, lastAppliedAt: null, lastError: null });

    await center.write('log.level', 'debug', apiCtx);
    expect(center.meta().lastAppliedAt).toBeTruthy();

    await center.write('db.driver', 'mysql', apiCtx).catch(() => undefined);
    expect(center.meta().lastError).toBeNull();
  });
});

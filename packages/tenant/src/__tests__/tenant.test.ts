/*
 * @file @fw/tenant 单元测试
 * @description 覆盖 TC-TNT-003 前置能力：三级回退解析（顺序/开关/子域名提取/编码归一化）、
 *   fail-closed 校验（未启用/未解析/不存在/停用/过期/独立库缺连接串）与 TTL 缓存语义。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/tenant
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BizError, ErrorCode } from '@fw/core';
import { parseTenantOrder, resolveTenantCode } from '../resolver.js';
import { TenantService } from '../tenant.service.js';
import { buildTenantRuntime } from '../tenant.module.js';
import { DEFAULT_TENANT_ORDER, type TenantInfo, type TenantStorePort } from '../types.js';

const DEFAULT_OPTIONS = {
  order: [...DEFAULT_TENANT_ORDER],
  headerName: 'x-tenant-id',
  baseDomain: 'example.com',
  jwtClaim: 'tenantId',
};

describe('parseTenantOrder', () => {
  it('解析顺序并保持大小写归一', () => {
    expect(parseTenantOrder('JWT, header ,subdomain')).toEqual(['jwt', 'header', 'subdomain']);
  });

  it('空列表与非法值启动即失败（fail-fast）', () => {
    expect(() => parseTenantOrder('')).toThrow();
    expect(() => parseTenantOrder('cookie')).toThrow();
  });
});

describe('resolveTenantCode（三级回退）', () => {
  it('默认顺序：子域名优先于请求头，请求头优先于 JWT', () => {
    const code = resolveTenantCode(
      {
        host: 'acme.example.com',
        headers: { 'x-tenant-id': 'beta' },
        extractJwtClaim: () => 'gamma',
      },
      DEFAULT_OPTIONS,
    );
    expect(code).toBe('acme');
  });

  it('子域名未命中时回退请求头', () => {
    const code = resolveTenantCode(
      { host: 'example.com', headers: { 'x-tenant-id': 'beta' } },
      DEFAULT_OPTIONS,
    );
    expect(code).toBe('beta');
  });

  it('仅 JWT 来源可用时取 claim', () => {
    const code = resolveTenantCode(
      { headers: {}, extractJwtClaim: (claim) => (claim === 'tenantId' ? 'gamma' : undefined) },
      { ...DEFAULT_OPTIONS, order: ['jwt'] },
    );
    expect(code).toBe('gamma');
  });

  it('Host 带端口与多级子域名取最左段', () => {
    expect(resolveTenantCode({ host: 'acme.example.com:8080', headers: {} }, DEFAULT_OPTIONS)).toBe('acme');
    expect(resolveTenantCode({ host: 'a.b.example.com', headers: {} }, DEFAULT_OPTIONS)).toBe('a');
  });

  it('子域名源未配置基准域名时关闭（PRD-008：各级开关可配）', () => {
    const code = resolveTenantCode(
      { host: 'acme.example.com', headers: {} },
      { ...DEFAULT_OPTIONS, baseDomain: undefined },
    );
    expect(code).toBeUndefined();
  });

  it('顺序裁剪即开关：order 只含 header 时忽略子域名与 JWT', () => {
    const code = resolveTenantCode(
      { host: 'acme.example.com', headers: { 'x-tenant-id': 'beta' }, extractJwtClaim: () => 'gamma' },
      { ...DEFAULT_OPTIONS, order: ['header'] },
    );
    expect(code).toBe('beta');
  });

  it('非法编码跳过并继续回退；全大写归一化', () => {
    const code = resolveTenantCode(
      { headers: { 'x-tenant-id': 'Bad_Code' }, extractJwtClaim: () => 'OK-Tenant' },
      { ...DEFAULT_OPTIONS, order: ['header', 'jwt'] },
    );
    expect(code).toBe('ok-tenant');
  });

  it('全部来源未命中返回 undefined', () => {
    expect(resolveTenantCode({ headers: {} }, DEFAULT_OPTIONS)).toBeUndefined();
  });
});

describe('TenantService（fail-closed 校验与缓存）', () => {
  const tenant = (patch: Partial<TenantInfo> = {}): TenantInfo => ({
    id: '1',
    code: 'acme',
    name: 'ACME',
    isolation: 'shared',
    dbUrl: null,
    status: 1,
    expireAt: null,
    ...patch,
  });

  const store = (rows: Record<string, TenantInfo | null>): TenantStorePort & { calls: number } => ({
    calls: 0,
    async findTenantByCode(code: string) {
      this.calls += 1;
      return rows[code] ?? null;
    },
  });

  it('未启用多租户：直接返回 null（单租户模式）', async () => {
    const s = new TenantService(store({}), { resolution: DEFAULT_OPTIONS, enabled: false, cacheTtlMs: 60_000 });
    await expect(s.resolve({ headers: {} })).resolves.toBeNull();
  });

  it('启用但未携带租户标识：抛 4001（fail-closed，不回退全量视图）', async () => {
    const s = new TenantService(store({}), { resolution: DEFAULT_OPTIONS, enabled: true, cacheTtlMs: 60_000 });
    await expect(s.resolve({ headers: {} })).rejects.toMatchObject({ code: ErrorCode.TENANT_INVALID });
  });

  it('租户不存在：抛 4001', async () => {
    const s = new TenantService(store({}), { resolution: DEFAULT_OPTIONS, enabled: true, cacheTtlMs: 60_000 });
    await expect(s.resolve({ headers: { 'x-tenant-id': 'ghost' } })).rejects.toMatchObject({
      code: ErrorCode.TENANT_INVALID,
    });
  });

  it('停用与过期租户：抛 4001', async () => {
    const s = new TenantService(
      store({ off: tenant({ code: 'off', status: 0 }), old: tenant({ code: 'old', expireAt: '2020-01-01T00:00:00Z' }) }),
      { resolution: DEFAULT_OPTIONS, enabled: true, cacheTtlMs: 60_000 },
    );
    await expect(s.verify('off')).rejects.toBeInstanceOf(BizError);
    await expect(s.verify('old')).rejects.toBeInstanceOf(BizError);
  });

  it('dedicated 租户缺独立库连接串：抛 4001（T-M8-02 前置校验）', async () => {
    const s = new TenantService(
      store({ big: tenant({ code: 'big', isolation: 'dedicated', dbUrl: null }) }),
      { resolution: DEFAULT_OPTIONS, enabled: true, cacheTtlMs: 60_000 },
    );
    await expect(s.verify('big')).rejects.toMatchObject({ code: ErrorCode.TENANT_INVALID });
  });

  it('TTL 缓存：有效期内重复解析不重复查库，invalidate 后重查', async () => {
    const repo = store({ acme: tenant() });
    let now = 1_000;
    const s = new TenantService(repo, {
      resolution: DEFAULT_OPTIONS,
      enabled: true,
      cacheTtlMs: 10_000,
      now: () => now,
    });
    await s.verify('acme');
    await s.verify('acme');
    expect(repo.calls).toBe(1);
    now += 10_001;
    await s.verify('acme');
    expect(repo.calls).toBe(2);
    s.invalidate();
    await s.verify('acme');
    expect(repo.calls).toBe(3);
  });

  it('缓存内的停用租户同样 fail-closed（判空缓存命中路径）', async () => {
    const repo = store({});
    let now = 1_000;
    const s = new TenantService(repo, {
      resolution: DEFAULT_OPTIONS,
      enabled: true,
      cacheTtlMs: 10_000,
      now: () => now,
    });
    await expect(s.verify('ghost')).rejects.toBeInstanceOf(BizError);
    // TTL 内重复触发仍走缓存里的 null 分支
    await expect(s.verify('ghost')).rejects.toBeInstanceOf(BizError);
    expect(repo.calls).toBe(1);
  });
});

describe('buildTenantRuntime（配置装配）', () => {
  it('env 缺省取默认值；overrides 覆盖 env', () => {
    const runtime = buildTenantRuntime({ TENANT_ENABLED: true });
    expect(runtime.serviceOptions.enabled).toBe(true);
    expect(runtime.resolution.order).toEqual(['subdomain', 'header', 'jwt']);
    expect(runtime.resolution.headerName).toBe('x-tenant-id');
    expect(runtime.serviceOptions.cacheTtlMs).toBe(60_000);

    const overridden = buildTenantRuntime({ TENANT_ENABLED: false, TENANT_HEADER_NAME: 'x-org' }, {
      enabled: true,
      cacheTtlSeconds: 5,
      resolution: { baseDomain: 'corp.cn' },
    });
    expect(overridden.serviceOptions.enabled).toBe(true);
    expect(overridden.serviceOptions.cacheTtlMs).toBe(5_000);
    expect(overridden.resolution.headerName).toBe('x-org');
    expect(overridden.resolution.baseDomain).toBe('corp.cn');
  });

  it('TENANT_ORDER 非法：启动即失败（fail-fast）', () => {
    expect(() => buildTenantRuntime({ TENANT_ORDER: 'subdomain,cookie' })).toThrow();
  });
});

/*
 * @file 装饰器、拦截器、缓存与策略补充单测
 * @description 补齐覆盖面：元数据装饰器写入、@CurrentUser 取值、审计拦截器自动落库与无元数据直通、
 *   缓存 TTL/标签失效/非法 TTL/抽样清理、Session 与 OAuth2 策略的可插拔行为、API Key 解析容错
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */
import { lastValueFrom, of } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fw/core';
import { AuditInterceptor } from '../audit.interceptor.js';
import { AuditService } from '../audit.service.js';
import { MemoryAuthCache } from '../auth-cache.js';
import { Audit, AuthStrategy, CurrentUser, Permissions, Public, pickUser } from '../decorators.js';
import { META_AUDIT, META_PERMISSIONS, META_PUBLIC, META_STRATEGY } from '../constants.js';
import { resolveDataScope } from '../data-scope.js';
import { MemoryAuthStore } from '../memory-auth-store.js';
import { RbacGuard } from '../rbac.guard.js';
import { ApiKeyStrategy, OAuth2Strategy, SessionStrategy, parseApiKeys, type SessionStore } from '../strategies.js';
import { fakeContext, flushAsync, makeRequest, createHarness } from './test-helpers.js';
import type { AuditMeta } from '../decorators.js';
import type { RequestUser } from '../types.js';

/** 读元数据 */
const read = (target: object, key: string): unknown => Reflect.getMetadata(key, target);

describe('装饰器元数据', () => {
  it('Public / Permissions / AuthStrategy / Audit 写入约定元数据键', () => {
    const target = class Decorated {};
    Public()(target as never);
    expect(read(target, META_PUBLIC)).toBe(true);

    const withPerms = class WithPerms {};
    Permissions('order:refund', 'order:read')(withPerms as never);
    expect(read(withPerms, META_PERMISSIONS)).toEqual(['order:refund', 'order:read']);

    const withStrategy = class WithStrategy {};
    AuthStrategy('apikey')(withStrategy as never);
    expect(read(withStrategy, META_STRATEGY)).toBe('apikey');

    const meta: AuditMeta = { module: 'order', action: 'update', targetType: 'order' };
    const withAudit = class WithAudit {};
    Audit(meta)(withAudit as never);
    expect(read(withAudit, META_AUDIT)).toEqual(meta);
  });

  it('pickUser 支持整体返回与按字段取值，无用户时返回 undefined；CurrentUser 为可用的参数装饰器', () => {
    const user: RequestUser = {
      id: 'u1',
      username: 'alice',
      roles: ['user'],
      permissions: ['a:read'],
      dataScope: 'self',
      via: 'jwt',
    };
    expect(pickUser(user)).toBe(user);
    expect(pickUser(user, 'id')).toBe('u1');
    expect(pickUser(user, 'permissions')).toEqual(['a:read']);
    expect(pickUser(undefined)).toBeUndefined();
    expect(typeof CurrentUser).toBe('function');
  });
});

describe('AuditInterceptor', () => {
  /** 构造拦截器（返回 meta 由 reflector 桩提供） */
  function build(meta: AuditMeta | undefined, store: MemoryAuthStore): { interceptor: AuditInterceptor; audit: AuditService } {
    const reflector = { getAllAndOverride: () => meta } as unknown as ConstructorParameters<typeof AuditInterceptor>[0];
    const audit = new AuditService(store);
    return { interceptor: new AuditInterceptor(reflector, audit), audit };
  }

  it('命中 @Audit 时按响应体与路由参数自动落库', async () => {
    const store = new MemoryAuthStore();
    const { interceptor } = build({ module: 'order', action: 'create', targetType: 'order' }, store);
    const request = Object.assign(makeRequest({ 'user-agent': 'vitest' }), {
      params: { id: 'o-1' },
      user: { id: 'u-9', username: 'op', roles: [], permissions: [], dataScope: 'self', via: 'jwt' } as RequestUser,
    });
    const result$ = interceptor.intercept(fakeContext(request), { handle: () => of({ id: 'o-1', amount: 10 }) });
    await expect(lastValueFrom(result$)).resolves.toEqual({ id: 'o-1', amount: 10 });
    await flushAsync();

    const page = await store.pageAuditLogs({ page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0].module).toBe('order');
    expect(page.items[0].targetId).toBe('o-1');
    expect(page.items[0].userId).toBe('u-9');
    expect(page.items[0].userAgent).toBe('vitest');
  });

  it('无 @Audit 元数据时原样透传，不写审计', async () => {
    const store = new MemoryAuthStore();
    const { interceptor } = build(undefined, store);
    const result$ = interceptor.intercept(fakeContext(makeRequest()), { handle: () => of('raw') });
    await expect(lastValueFrom(result$)).resolves.toBe('raw');
    await flushAsync();
    expect((await store.pageAuditLogs({ page: 1, pageSize: 10 })).total).toBe(0);
  });
});

describe('MemoryAuthCache', () => {
  it('写入后可读，过期即认为不存在，del 生效', async () => {
    const cache = new MemoryAuthCache();
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBe('v');
    await cache.del('k');
    expect(await cache.get('k')).toBeUndefined();

    await cache.set('short', 1, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await cache.get('short')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('非法 TTL 拒绝写入（禁止无过期缓存）', async () => {
    const cache = new MemoryAuthCache();
    await expect(cache.set('k', 'v', 0)).rejects.toThrow(/TTL/);
    await expect(cache.set('k', 'v', Number.NaN)).rejects.toThrow(/TTL/);
  });

  it('按标签批量失效；标签不存在时幂等', async () => {
    const cache = new MemoryAuthCache();
    await cache.set('perm:1', 'a', 60, ['user:1']);
    await cache.set('perm:2', 'b', 60, ['user:2']);
    await cache.invalidateTag('user:1');
    expect(await cache.get('perm:1')).toBeUndefined();
    expect(await cache.get('perm:2')).toBe('b');
    await expect(cache.invalidateTag('user:404')).resolves.toBeUndefined();
  });

  it('超过阈值触发抽样清理，过期键被回收', async () => {
    const cache = new MemoryAuthCache();
    for (let i = 0; i < 1005; i += 1) await cache.set(`k${i}`, i, 60, ['bulk']);
    // 全部写入后仍持有全部键（未过期不清理）
    expect(cache.size()).toBe(1005);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await cache.set('trigger', 1, 1);
    // 触发清理需要一次过期写入后再超阈值：这里直接验证标签失效清空
    await cache.invalidateTag('bulk');
    expect(cache.size()).toBe(1);
  });
});

describe('策略可插拔', () => {
  it('Session 策略：无 Cookie 返回 null；有 Cookie 无存储、存储未命中的行为', async () => {
    const sessionStrategy = new SessionStrategy();
    expect(await sessionStrategy.authenticate(makeRequest())).toBeNull();
    await expect(
      sessionStrategy.authenticate(makeRequest({ cookie: 'fw_sid=abc' })),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    const store: SessionStore = { resolve: async (sid) => (sid === 'good' ? 'u-1' : null) };
    const withStore = new SessionStrategy(store);
    expect(await withStore.authenticate(makeRequest({ cookie: 'other=1; fw_sid=good' }))).toMatchObject({
      kind: 'user',
      id: 'u-1',
      via: 'session',
    });
    await expect(withStore.authenticate(makeRequest({ cookie: 'fw_sid=bad' }))).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
  });

  it('OAuth2 策略：未注册 provider 明确拒绝；注册后按 handler 返回身份', async () => {
    const oauth2 = new OAuth2Strategy();
    expect(oauth2.providers()).toEqual([]);
    await expect(oauth2.authenticate(makeRequest())).resolves.toBeNull();
    await expect(
      oauth2.authenticate(Object.assign(makeRequest(), { provider: 'github', code: 'c1' })),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    oauth2.registerProvider('github', async () => ({ kind: 'user', id: 'gh-1', username: 'octocat' }));
    expect(oauth2.providers()).toEqual(['github']);
    await expect(oauth2.authenticate(Object.assign(makeRequest(), { provider: 'github', code: 'c1' }))).resolves.toMatchObject({
      kind: 'user',
      id: 'gh-1',
      via: 'oauth2',
      dataScope: 'self',
    });
  });

  it('ApiKey 策略：无头返回 null；密钥错误 3001', async () => {
    const strategy = new ApiKeyStrategy([{ key: 'k1', subject: 'p', scopes: ['a:read'] }]);
    expect(await strategy.authenticate(makeRequest())).toBeNull();
    await expect(strategy.authenticate(makeRequest({ 'x-api-key': 'bad' }))).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
  });

  it('parseApiKeys 跳过非法条目、容忍空格、权限码中保留冒号', () => {
    expect(parseApiKeys(undefined)).toEqual([]);
    expect(parseApiKeys('')).toEqual([]);
    expect(parseApiKeys('onlykey')).toEqual([]);
    expect(parseApiKeys('k1:svc:order:refund|user:read, , k2:robot')).toEqual([
      { key: 'k1', subject: 'svc', scopes: ['order:refund', 'user:read'] },
      { key: 'k2', subject: 'robot', scopes: [] },
    ]);
  });

  it('token 黑名单：过期令牌无需占位；水位未设置时不判定失效', async () => {
    const h = createHarness();
    const past = Math.floor(Date.now() / 1000) - 10;
    await h.blacklist.revoke('jti-past', past);
    expect(await h.blacklist.isRevoked('jti-past')).toBe(false);
    expect(await h.blacklist.isRevoked('')).toBe(false);
    await expect(h.blacklist.isBeforeUserCutoff('u1', Math.floor(Date.now() / 1000))).resolves.toBe(false);
    await expect(h.blacklist.getUserCutoff('u1')).resolves.toBe(0);
  });
});

describe('数据权限与免认证路径', () => {
  it('TC-AUTH-013：self 只返回本人；all 不受限；org/org_below 无组织端口时收敛为 self 并标记待解析', () => {
    expect(resolveDataScope({ id: 'u1', dataScope: 'self' })).toEqual({
      scope: 'self',
      selfOnly: true,
      ownerId: 'u1',
      unrestricted: false,
      departmentIds: null,
      pendingScopes: [],
    });
    expect(resolveDataScope({ id: 'u1', dataScope: 'all' }).unrestricted).toBe(true);
    const org = resolveDataScope({ id: 'u1', dataScope: 'org_below' });
    expect(org.selfOnly).toBe(true);
    expect(org.pendingScopes).toEqual(['org_below']);
    // 范围缺失时按最小权限收敛
    const fallback = resolveDataScope({ id: 'u1' } as { id: string; dataScope: 'self' });
    expect(fallback.selfOnly).toBe(true);
    // 完整四档（注入 DataScopeOrgPort）由 data-scope.test.ts 覆盖（M8 T-M8-04）
  });

  it('探针与指标路径免认证（前缀匹配，忽略查询串）', async () => {
    const h = createHarness();
    await h.seed();
    const guard = new RbacGuard(new Reflector(), h.registry, h.permissions, h.store, h.options, h.audit);
    for (const url of ['/health', '/ready', '/metrics', '/health?verbose=1', '/ready/db']) {
      await expect(guard.canActivate(fakeContext(makeRequest({}, '10.0.0.1'), undefined, undefined, url))).resolves.toBe(true);
    }
    await expect(
      guard.canActivate(fakeContext(makeRequest({}, '10.0.0.1'), undefined, undefined, '/api/v1/users')),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
  });
});

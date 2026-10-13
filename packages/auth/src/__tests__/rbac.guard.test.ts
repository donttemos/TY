/*
 * @file RBAC 守卫单测
 * @description 覆盖 TC-AUTH-003（未登录 3001 且不泄漏资源存在性）、TC-AUTH-004（无权限 3002）、
 *   TC-AUTH-005（过期 3003）、TC-AUTH-010（登出后黑名单生效）、改密水位失效、禁用账号 3004、
 *   TC-AUTH-012（jwt 与 apikey 多策略共存、按路由切换）、@Public 放行与凭证异常降级
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */
import { Reflector } from '@nestjs/core';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { BizError, ErrorCode } from '@fw/core';
import { getRequestContext, runWithRequestContext } from '@fw/logger';
import { JWT_ISSUER, META_IGNORE_TENANT, META_PERMISSIONS, META_PUBLIC, META_STRATEGY, PERM } from '../constants.js';
import { IgnoreTenant } from '../index.js';
import { RbacGuard } from '../rbac.guard.js';
import { ApiKeyStrategy, JwtStrategy, StrategyRegistry } from '../strategies.js';
import { TEST_SECRET, createHarness, fakeContext, makeRequest } from './test-helpers.js';
import type { GuardRequest } from '../rbac.guard.js';

/** 打元数据（不用装饰器语法，避免依赖 esbuild 的装饰器转译） */
function meta(target: object, key: string | symbol, value: unknown, propertyKey?: string): void {
  if (propertyKey) {
    const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
    Reflect.defineMetadata(key, value, descriptor?.value as object);
  } else {
    Reflect.defineMetadata(key, value, target);
  }
}

const handler = (): void => undefined;
const controller = class TestController {};

describe('RbacGuard', () => {
  /** 构造守卫（默认 jwt，可注入 apikey 配置） */
  function buildGuard(h: ReturnType<typeof createHarness>): RbacGuard {
    const registry = new StrategyRegistry([
      new JwtStrategy(h.tokens, h.blacklist),
      new ApiKeyStrategy(h.options.apiKeys),
    ]);
    return new RbacGuard(new Reflector(), registry, h.permissions, h.store, h.options, h.audit);
  }

  it('TC-AUTH-003：无令牌访问受保护接口返回 3001', async () => {
    const h = createHarness();
    await h.seed();
    const guard = buildGuard(h);
    await expect(guard.canActivate(fakeContext(makeRequest(), handler, controller))).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
      http: 401,
    });
  });

  it('有效令牌放行并写入 request.user（含角色、权限、数据范围）', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const access = await h.tokens.signAccess({ id: seeded.admin.id, username: 'admin', roles: ['admin'] }, 'fam-1');
    const request = makeRequest({ authorization: `Bearer ${access.token}` });

    const guard = buildGuard(h);
    await expect(guard.canActivate(fakeContext(request, handler, controller))).resolves.toBe(true);
    expect(request.user?.id).toBe(seeded.admin.id);
    expect(request.user?.roles).toEqual(['admin']);
    expect(request.user?.permissions).toContain(PERM.USER_READ);
    expect(request.user?.dataScope).toBe('all');
    expect(request.user?.jti).toBe(access.jti);
  });

  it('TC-TNT-001/002：请求租户必须与用户归属一致，缺失归属 fail-closed', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const access = await h.tokens.signAccess({ id: seeded.normal.id, username: 'alice', roles: ['user'] });
    const guard = buildGuard(h);
    const attempt = () => runWithRequestContext({ traceId: 'tenant-auth', spanId: '', tenantId: '17' }, () =>
      guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${access.token}` }), handler, controller)));

    await expect(attempt()).rejects.toMatchObject({ code: ErrorCode.TENANT_INVALID });
    await h.store.updateUser(seeded.normal.id, { tenantId: '18' });
    await expect(attempt()).rejects.toMatchObject({ code: ErrorCode.TENANT_INVALID });
    await h.store.updateUser(seeded.normal.id, { tenantId: '17' });
    await expect(attempt()).resolves.toBe(true);
    const verified = await runWithRequestContext({ traceId: 'verified', spanId: '', tenantId: '17' }, async () => {
      await guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${access.token}` }), handler, controller));
      return getRequestContext()?.tenantVerified;
    });
    expect(verified).toBe(true);
  });

  it('@IgnoreTenant requires an explicit permission and audits the bypass', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const access = await h.tokens.signAccess({ id: seeded.normal.id, username: 'alice', roles: ['user'] });
    const guard = buildGuard(h);
    const maintenance = (): void => undefined;
    IgnoreTenant()(maintenance as never, 'handler' as never, { value: maintenance } as never);
    expect(Reflect.getMetadata(META_IGNORE_TENANT, maintenance)).toBe(true);
    const attempt = () => runWithRequestContext({ traceId: 'maintenance', spanId: '' }, async () => {
      await guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${access.token}` }), maintenance, controller));
      return getRequestContext()?.ignoreTenant;
    });
    await expect(attempt()).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    const role = await h.store.listRolesByUserId(seeded.normal.id);
    const permission = h.store.seedPermission({ code: 'system:tenant:ignore', name: '跨租户维护', type: 'api', module: 'system' });
    await h.store.grantRolePermissions(role[0].id, [permission.id]);
    await h.permissions.invalidateUser(seeded.normal.id);
    await expect(attempt()).resolves.toBe(true);
    const audit = await h.store.pageAuditLogs({ page: 1, pageSize: 10, targetType: 'tenant_bypass' });
    expect(audit.items).toMatchObject([{ userId: seeded.normal.id, action: 'grant', targetType: 'tenant_bypass' }]);
  });

  it('TC-AUTH-004：缺少所需权限码返回 3002（在业务处理器之前拦截）', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const access = await h.tokens.signAccess({ id: seeded.normal.id, username: 'alice', roles: ['user'] }, 'fam-2');
    const request = makeRequest({ authorization: `Bearer ${access.token}` });
    meta(handler, META_PERMISSIONS, [PERM.USER_READ]);

    let reached = false;
    const probe = (): void => {
      reached = true;
    };
    meta(probe, META_PERMISSIONS, [PERM.USER_READ]);

    const guard = buildGuard(h);
    await expect(guard.canActivate(fakeContext(request, probe, controller))).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
      http: 403,
    });
    expect(reached).toBe(false);
  });

  it('@Public 路由无令牌放行；凭证异常时降级为匿名而非拒绝', async () => {
    const h = createHarness();
    await h.seed();
    const publicHandler = (): void => undefined;
    meta(publicHandler, META_PUBLIC, true);
    const guard = buildGuard(h);

    await expect(guard.canActivate(fakeContext(makeRequest(), publicHandler, controller))).resolves.toBe(true);
    const broken = makeRequest({ authorization: 'Bearer not-a-jwt' });
    await expect(guard.canActivate(fakeContext(broken, publicHandler, controller))).resolves.toBe(true);
    expect(broken.user).toBeUndefined();
  });

  it('TC-AUTH-010：令牌进黑名单后返回 3001', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const access = await h.tokens.signAccess({ id: seeded.admin.id, username: 'admin', roles: ['admin'] });
    await h.blacklist.revoke(access.jti, access.exp);
    const guard = buildGuard(h);
    await expect(
      guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${access.token}` }), handler, controller)),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
  });

  it('改密后旧 access 因用户水位失效（其它设备下线）', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const access = await h.tokens.signAccess({ id: seeded.admin.id, username: 'admin', roles: ['admin'] });
    // 水位设为令牌签发时间 + 1 秒 → 旧令牌失效，新令牌有效
    await h.blacklist.setUserCutoff(seeded.admin.id, access.exp - h.options.accessTtlSeconds + 1, 7200);
    const guard = buildGuard(h);
    await expect(
      guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${access.token}` }), handler, controller)),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
  });

  it('禁用账号返回 3004；账号被删除返回 3001', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const access = await h.tokens.signAccess({ id: seeded.normal.id, username: 'alice', roles: ['user'] });
    await h.store.updateUser(seeded.normal.id, { status: 0 });
    const guard = buildGuard(h);
    await expect(
      guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${access.token}` }), handler, controller)),
    ).rejects.toMatchObject({ code: ErrorCode.ACCOUNT_LOCKED });

    const ghost = await h.tokens.signAccess({ id: 'not-exist', username: 'ghost', roles: [] });
    await expect(
      guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${ghost.token}` }), handler, controller)),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
  });

  it('TC-AUTH-005：过期 access 返回 3003；refresh 令牌不得当 access 使用（3001）', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const guard = buildGuard(h);

    // 用 typ=refresh 的令牌访问受保护接口 → 3001
    const refresh = await h.tokens.signRefresh(seeded.admin.id, 'fam-x');
    await expect(
      guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${refresh.token}` }), handler, controller)),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    // 手工签发一个已过期的 access（用同一密钥，仅把 exp 放到过去）→ 3003
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ username: 'admin', roles: ['admin'], typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(JWT_ISSUER)
      .setSubject(seeded.admin.id)
      .setJti('expired-jti')
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 60)
      .sign(new TextEncoder().encode(TEST_SECRET));
    await expect(
      guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${expired}` }), handler, controller)),
    ).rejects.toMatchObject({ code: ErrorCode.TOKEN_EXPIRED, http: 401 });
  });

  it('TC-AUTH-012：同一服务内 jwt 与 apikey 策略按路由共存', async () => {
    const h = createHarness({ apiKeys: [{ key: 'k-open-1', subject: 'partner', scopes: ['order:read'] }] });
    const seeded = await h.seed();
    const guard = buildGuard(h);

    // 路由 A：默认 jwt
    const jwtHandler = (): void => undefined;
    meta(jwtHandler, META_PERMISSIONS, [PERM.USER_READ]);
    const access = await h.tokens.signAccess({ id: seeded.admin.id, username: 'admin', roles: ['admin'] });
    await expect(
      guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${access.token}` }), jwtHandler, controller)),
    ).resolves.toBe(true);

    // 路由 B：apikey 策略，声明 order:read
    const apiHandler = (): void => undefined;
    meta(apiHandler, META_STRATEGY, 'apikey');
    meta(apiHandler, META_PERMISSIONS, ['order:read']);
    const apiRequest: GuardRequest = makeRequest({ 'x-api-key': 'k-open-1' });
    await expect(guard.canActivate(fakeContext(apiRequest, apiHandler, controller))).resolves.toBe(true);
    expect(apiRequest.user?.isService).toBe(true);
    expect(apiRequest.user?.id).toBe('apikey:partner');

    // 错误 key → 3001；scope 不足 → 3002
    await expect(
      guard.canActivate(fakeContext(makeRequest({ 'x-api-key': 'wrong' }), apiHandler, controller)),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    const narrowHandler = (): void => undefined;
    meta(narrowHandler, META_STRATEGY, 'apikey');
    meta(narrowHandler, META_PERMISSIONS, [PERM.USER_DELETE]);
    await expect(
      guard.canActivate(fakeContext(makeRequest({ 'x-api-key': 'k-open-1' }), narrowHandler, controller)),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    // jwt 路由不因 apikey 缺失而失败（互不干扰）
    await expect(
      guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${access.token}` }), jwtHandler, controller)),
    ).resolves.toBe(true);
  });

  it('未注册策略名明确报错，不静默放行', async () => {
    const h = createHarness();
    await h.seed();
    const handler2 = (): void => undefined;
    meta(handler2, META_STRATEGY, 'session');
    const guard = buildGuard(h);
    await expect(
      guard.canActivate(fakeContext(makeRequest({ authorization: 'Bearer x' }), handler2, controller)),
    ).rejects.toBeInstanceOf(BizError);
  });
});

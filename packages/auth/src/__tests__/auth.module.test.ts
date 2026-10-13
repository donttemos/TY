/*
 * @file 模块装配与配置映射单测
 * @description 覆盖环境变量 → AuthOptions 映射（含 TTL 时长解析、API Key 解析、缺密钥/密钥相同的拒绝）、
 *   AuthModule.forRoot 的 DI 装配（AuthService 可解析、全局守卫与审计拦截器已注册并覆盖路由）
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fw/core';
import { AuthModule, buildAuthOptions } from '../auth.module.js';
import { MemoryAuthStore } from '../memory-auth-store.js';
import { RbacGuard } from '../rbac.guard.js';
import { AuditService } from '../audit.service.js';
import { AuthService } from '../auth.service.js';
import { PasswordService } from '../password.service.js';
import { PermissionService } from '../permission.service.js';
import { AUTH_OPTIONS, AUTH_STORE, AUTH_STRATEGY_REGISTRY } from '../tokens.js';
import { META_PERMISSIONS, PERM } from '../constants.js';
import { TEST_SECRET, TEST_SECRET_PREV, fakeContext, makeRequest } from './test-helpers.js';

/** 守卫测试用的空处理器与控制器 */
const handler = (): void => undefined;
const controller = class ModuleTestController {};

/** 最小环境变量集合 */
const ENV = {
  AUTH_STRATEGY: 'jwt' as const,
  AUTH_ACCESS_TTL: '30m',
  AUTH_REFRESH_TTL: '12h',
  AUTH_MAX_FAILED: 3,
  AUTH_LOCK_MINUTES: 5,
  AUTH_REFRESH_GRACE_SECONDS: 5,
  AUTH_PASSWORD_POLICY: 'high' as const,
  AUTH_ALLOW_REGISTER: false,
  JWT_SECRET: TEST_SECRET,
  JWT_SECRET_PREV: TEST_SECRET_PREV,
  AUTH_API_KEYS: 'k1:partner:order:read|order:write, k2:robot',
};

describe('buildAuthOptions', () => {
  it('环境变量完整映射为运行时配置（含时长与 API Key 解析）', () => {
    const options = buildAuthOptions(ENV);
    expect(options.strategy).toBe('jwt');
    expect(options.accessTtlSeconds).toBe(1800);
    expect(options.refreshTtlSeconds).toBe(43200);
    expect(options.maxFailed).toBe(3);
    expect(options.lockMinutes).toBe(5);
    expect(options.refreshGraceSeconds).toBe(5);
    expect(options.passwordPolicy).toBe('high');
    expect(options.allowRegister).toBe(false);
    expect(options.jwtSecretPrev).toBe(TEST_SECRET_PREV);
    expect(options.apiKeys).toEqual([
      { key: 'k1', subject: 'partner', scopes: ['order:read', 'order:write'] },
      { key: 'k2', subject: 'robot', scopes: [] },
    ]);
  });

  it('缺省环境变量回落安全默认值', () => {
    const options = buildAuthOptions({ JWT_SECRET: TEST_SECRET });
    expect(options.strategy).toBe('jwt');
    expect(options.accessTtlSeconds).toBe(7200);
    expect(options.refreshTtlSeconds).toBe(604800);
    expect(options.maxFailed).toBe(5);
    expect(options.lockMinutes).toBe(15);
    expect(options.passwordPolicy).toBe('medium');
    expect(options.apiKeys).toEqual([]);
  });

  it('缺少 JWT_SECRET 或轮换密钥与当前密钥相同 → 装配期直接失败', () => {
    expect(() => buildAuthOptions({})).toThrow(/JWT_SECRET/);
    expect(() => buildAuthOptions({ JWT_SECRET: TEST_SECRET, JWT_SECRET_PREV: TEST_SECRET })).toThrow(/不得与 JWT_SECRET 相同/);
  });

  it('overrides 优先于环境变量（测试与特殊部署用）', () => {
    const options = buildAuthOptions(ENV, { accessTtlSeconds: 60, allowRegister: true, passwordPolicy: 'low' });
    expect(options.accessTtlSeconds).toBe(60);
    expect(options.allowRegister).toBe(true);
    expect(options.passwordPolicy).toBe('low');
  });
});

describe('AuthModule.forRoot', () => {
  /** 装配测试模块并返回 Nest 模块引用 */
  async function compile(store: MemoryAuthStore): Promise<Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>> {
    return Test.createTestingModule({
      imports: [AuthModule.forRoot({ store, env: ENV })],
    }).compile();
  }

  /** 从模块定义中取出 provider token 列表 */
  function providerTokens(): unknown[] {
    const definition = AuthModule.forRoot({ store: new MemoryAuthStore(), env: ENV });
    return (definition.providers ?? []).map((provider) => (provider as { provide?: unknown }).provide);
  }

  it('注册全局守卫与审计拦截器，并声明全部对外 provider', () => {
    const tokens = providerTokens();
    expect(tokens).toContain(APP_GUARD);
    expect(tokens).toContain(APP_INTERCEPTOR);
    expect(tokens).toContain(AUTH_STORE);
    expect(tokens).toContain(AUTH_OPTIONS);
    expect(tokens).toContain(AuthService);
    expect(tokens).toContain(PermissionService);
  });

  it('可关闭全局守卫与拦截器（纯托管 / 测试场景）', () => {
    const tokens = (AuthModule.forRoot({ store: new MemoryAuthStore(), env: ENV, globalGuard: false, auditInterceptor: false })
      .providers ?? []).map((provider) => (provider as { provide?: unknown }).provide);
    expect(tokens).not.toContain(APP_GUARD);
    expect(tokens).not.toContain(APP_INTERCEPTOR);
  });

  it('DI 装配完整：核心服务可解析且共享同一 store / 配置', async () => {
    const store = new MemoryAuthStore();
    const moduleRef = await compile(store);

    const service = moduleRef.get(AuthService);
    const permissions = moduleRef.get(PermissionService);
    const audit = moduleRef.get(AuditService);
    const options = moduleRef.get(AUTH_OPTIONS);
    expect(service).toBeInstanceOf(AuthService);
    expect(permissions).toBeInstanceOf(PermissionService);
    expect(audit).toBeInstanceOf(AuditService);
    expect(options.accessTtlSeconds).toBe(1800);

    await moduleRef.close();
  });

  it('按装配出的依赖构造守卫可真实拦截：无令牌 3001、有权限放行、缺权限 3002', async () => {
    const store = new MemoryAuthStore();
    const moduleRef = await compile(store);
    const service = moduleRef.get(AuthService);
    const passwords = moduleRef.get(PasswordService);
    const guard = new RbacGuard(
      new Reflector(),
      moduleRef.get(AUTH_STRATEGY_REGISTRY),
      moduleRef.get(PermissionService),
      store,
      moduleRef.get(AUTH_OPTIONS),
      moduleRef.get(AuditService),
    );

    const adminRole = store.seedRole({ code: 'admin', name: 'admin', dataScope: 'all', isSystem: true });
    const readPermission = store.seedPermission({ code: PERM.USER_READ, name: '读用户', type: 'api', module: 'user' });
    await store.replaceRolePermissions(adminRole.id, [readPermission.id]);
    const user = store.seedUser({
      username: 'admin',
      phone: null,
      email: null,
      passwordHash: await passwords.hash('Admin@12345'),
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    await store.replaceUserRoles(user.id, [adminRole.id]);

    const login = await service.login({ account: 'admin', password: 'Admin@12345', ip: '10.0.0.1' });

    // 无令牌 → 3001
    await expect(guard.canActivate(fakeContext(makeRequest(), handler, controller))).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });

    // 有 user:read → 放行
    const handler2 = (): void => undefined;
    Reflect.defineMetadata(META_PERMISSIONS, [PERM.USER_READ], handler2);
    await expect(
      guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${login.accessToken}` }), handler2, controller)),
    ).resolves.toBe(true);

    // 缺 user:delete → 3002
    const handler3 = (): void => undefined;
    Reflect.defineMetadata(META_PERMISSIONS, [PERM.USER_DELETE], handler3);
    await expect(
      guard.canActivate(fakeContext(makeRequest({ authorization: `Bearer ${login.accessToken}` }), handler3, controller)),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    await moduleRef.close();
  });
});

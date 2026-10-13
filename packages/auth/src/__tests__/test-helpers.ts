/*
 * @file 测试脚手架
 * @description 提供内存实现装配（store / cache / 服务全集）、标准权限数据与伪执行上下文，
 *   使各测试文件只关注被验证行为；不依赖数据库、不需要 JWT_SECRET 环境变量。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

import type { ExecutionContext } from '@nestjs/common';
import { AuditService } from '../audit.service.js';
import { MemoryAuthCache } from '../auth-cache.js';
import { AuthService } from '../auth.service.js';
import { LoginSecurity } from '../login-security.js';
import { MemoryAuthStore } from '../memory-auth-store.js';
import { PasswordService } from '../password.service.js';
import { PermissionService } from '../permission.service.js';
import { RefreshTokenService } from '../refresh-token.service.js';
import { ApiKeyStrategy, JwtStrategy, StrategyRegistry } from '../strategies.js';
import { TokenService } from '../token.service.js';
import { TokenBlacklist } from '../token-blacklist.js';
import { PERM, ROLE } from '../constants.js';
import type { GuardRequest } from '../rbac.guard.js';
import type { AuthOptions, AuthRole, AuthUser, MenuNode } from '../types.js';

/** 测试用强密钥（≥32 字符） */
export const TEST_SECRET = 'unit-test-secret-key-0123456789abcdef';
/** 测试用上一版密钥（轮换过渡） */
export const TEST_SECRET_PREV = 'unit-test-prev-secret-key-0123456789ab';

/** 构造运行时配置 */
export function buildTestOptions(overrides: Partial<AuthOptions> = {}): AuthOptions {
  return {
    strategy: 'jwt',
    accessTtlSeconds: 2 * 60 * 60,
    refreshTtlSeconds: 7 * 24 * 60 * 60,
    maxFailed: 5,
    lockMinutes: 15,
    refreshGraceSeconds: 10,
    passwordPolicy: 'medium',
    allowRegister: true,
    jwtSecret: TEST_SECRET,
    jwtSecretPrev: undefined,
    apiKeys: [],
    loginRateLimit: { windowSeconds: 60, max: 1000 },
    permissionCacheTtlSeconds: 60,
    publicPaths: ['/health', '/ready', '/metrics'],
    ...overrides,
  };
}

/** 装配结果 */
export interface Harness {
  store: MemoryAuthStore;
  cache: MemoryAuthCache;
  options: AuthOptions;
  passwords: PasswordService;
  tokens: TokenService;
  blacklist: TokenBlacklist;
  refresh: RefreshTokenService;
  security: LoginSecurity;
  permissions: PermissionService;
  audit: AuditService;
  registry: StrategyRegistry;
  service: AuthService;
  /** 标准数据：admin / user 角色、权限点、菜单 */
  seed: () => Promise<SeedResult>;
}

/** 标准种子数据 */
export interface SeedResult {
  adminRole: AuthRole;
  userRole: AuthRole;
  admin: AuthUser;
  normal: AuthUser;
  menus: MenuNode[];
  /** 与 admin 绑定的明文密码 */
  adminPassword: string;
}

/**
 * 装配内存版鉴权栈
 * @param overrides 运行时配置覆盖
 */
export function createHarness(overrides: Partial<AuthOptions> = {}): Harness {
  const options = buildTestOptions(overrides);
  const store = new MemoryAuthStore();
  const cache = new MemoryAuthCache();
  const passwords = new PasswordService(options.passwordPolicy);
  const tokens = new TokenService({
    secret: options.jwtSecret,
    secretPrev: options.jwtSecretPrev,
    accessTtlSeconds: options.accessTtlSeconds,
    refreshTtlSeconds: options.refreshTtlSeconds,
  });
  const blacklist = new TokenBlacklist(cache);
  const refresh = new RefreshTokenService(store, tokens, options.refreshGraceSeconds);
  const security = new LoginSecurity(cache, {
    maxFailed: options.maxFailed,
    lockMinutes: options.lockMinutes,
    rateLimit: options.loginRateLimit,
  });
  const permissions = new PermissionService(store, cache, options.permissionCacheTtlSeconds);
  const audit = new AuditService(store);
  const registry = new StrategyRegistry([new JwtStrategy(tokens, blacklist), new ApiKeyStrategy(options.apiKeys)]);
  const service = new AuthService({ store, passwords, tokens, refresh, blacklist, security, permissions, audit, options });

  const seed = async (): Promise<SeedResult> => {
    const adminRole = store.seedRole({ code: ROLE.ADMIN, name: '超级管理员', dataScope: 'all', isSystem: true });
    const userRole = store.seedRole({ code: ROLE.USER, name: '普通用户', dataScope: 'self', isSystem: true });
    const allPermissions = Object.values(PERM).map((code) =>
      store.seedPermission({ code, name: code, type: 'api', module: code.split(':')[0] }),
    );
    // 额外业务权限点：验证「业务权限码 → 菜单可见性」链路（PRD-003 FR-09）
    const businessPermission = store.seedPermission({ code: 'order:refund', name: '订单退款', type: 'api', module: 'order' });
    await store.replaceRolePermissions(
      adminRole.id,
      [...allPermissions, businessPermission].map((p) => p.id),
    );

    const adminPassword = 'Admin@12345';
    const admin = store.seedUser({
      username: 'admin',
      phone: null,
      email: null,
      passwordHash: await passwords.hash(adminPassword),
      nickname: '管理员',
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    const normal = store.seedUser({
      username: 'alice',
      phone: null,
      email: null,
      passwordHash: await passwords.hash('Alice@12345'),
      nickname: 'Alice',
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    await store.replaceUserRoles(admin.id, [adminRole.id]);
    await store.replaceUserRoles(normal.id, [userRole.id]);

    // 菜单：一项登录即可见，一项需要 user:read，一项需要 order:refund（未授权）
    store.seedMenu({
      parentId: '0',
      name: '控制台',
      path: '/dashboard',
      component: 'dashboard/index',
      icon: 'home',
      permissionCode: null,
      visible: true,
      sort: 1,
    });
    store.seedMenu({
      parentId: '0',
      name: '用户管理',
      path: '/users',
      component: 'users/index',
      icon: 'user',
      permissionCode: PERM.USER_READ,
      visible: true,
      sort: 2,
    });
    store.seedMenu({
      parentId: '0',
      name: '订单退款',
      path: '/refund',
      component: 'order/refund',
      icon: 'money',
      permissionCode: 'order:refund',
      visible: true,
      sort: 3,
    });
    const menus = await permissions.getMenuTree(admin.id);
    return { adminRole, userRole, admin, normal, menus, adminPassword };
  };

  return { store, cache, options, passwords, tokens, blacklist, refresh, security, permissions, audit, registry, service, seed };
}

/**
 * 伪执行上下文（守卫测试用，不依赖 HTTP 框架）
 * @param request 请求对象
 * @param handler 处理函数（承载元数据）
 * @param controller 控制器类
 * @param url 覆盖请求 URL（探针路径测试用）
 */
export function fakeContext(
  request: GuardRequest,
  handler: (...args: unknown[]) => unknown = () => undefined,
  controller: new () => unknown = class {},
  url?: string,
): ExecutionContext {
  if (url) request.url = url;
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
    getType: () => 'http',
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
  } as unknown as ExecutionContext;
}

/** 构造最小请求对象 */
export function makeRequest(headers: Record<string, string> = {}, ip = '10.0.0.1'): GuardRequest {
  return { headers, ip, url: '/test', method: 'GET' };
}

/** 等待微任务队列清空（异步审计落盘） */
export async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/*
 * @file RBAC 全局守卫
 * @description PRD-003 FR-05 与 TC-AUTH-003/004/009：认证（策略解析身份）+ 授权（权限码比对）合一。
 *   顺序：路由元数据 → 策略解析身份 → 账号状态校验 → 加载权限（缓存）→ 权限比对 → 写请求上下文。
 *   失败语义：未携带/无效凭证 3001，令牌过期 3003，账号锁定或禁用 3004，权限不足 3002；
 *   权限判定发生在业务处理器之前，因此不会泄漏资源是否存在。
 *   `@Public()` 路由仍会尽力解析身份（便于公开接口记录操作人），但凭证异常时降级为匿名而非拒绝。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 依赖改值导入 + @Inject 令牌（类型导入导致 DI 元数据为 Function/Object，装配失败）
 * @module @fw/auth
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BizError, ErrorCode } from '@fw/core';
import { Logger, patchRequestContext } from '@fw/logger';
import type { AuthStore } from './auth-store.js';
import { META_PERMISSIONS, META_PUBLIC, META_STRATEGY } from './constants.js';
// 注意：以下三个依赖必须「值导入」——仅在类型位置引用时 emitDecoratorMetadata 只能发出
// Function / Object，Nest 无法解析构造函数依赖（启动期直接 DI 失败）。
import { PermissionService } from './permission.service.js';
import { StrategyRegistry, type AuthRequest, type AuthStrategy, type StrategyIdentity } from './strategies.js';
import { AUTH_OPTIONS, AUTH_STORE, AUTH_STRATEGY_REGISTRY } from './tokens.js';
import type { AuthOptions, AuthStrategyName, RequestUser } from './types.js';

const logger = Logger.for('auth.guard');

/** 守卫所需的请求形状（兼容 Express / Fastify：只用到公共字段） */
export interface GuardRequest extends AuthRequest {
  method?: string;
  url?: string;
  /** 由守卫写入：当前请求用户 */
  user?: RequestUser;
}

/**
 * RBAC 守卫：注册为 APP_GUARD 后对所有路由生效
 */
@Injectable()
export class RbacGuard implements CanActivate {
  /**
   * @param reflector 元数据读取
   * @param registry 策略注册表
   * @param permissions 权限服务
   * @param store 鉴权存储（校验账号状态）
   * @param options 运行时配置（含默认策略 AUTH_STRATEGY）
   */
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_STRATEGY_REGISTRY) private readonly registry: StrategyRegistry,
    private readonly permissions: PermissionService,
    @Inject(AUTH_STORE) private readonly store: AuthStore,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
  ) {}

  /**
   * 守卫主流程
   * @param context Nest 执行上下文
   * @returns 恒为 true；失败抛 BizError（由全局异常过滤器转统一响应）
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();
    const targets = [handler, controller];

    const request = context.switchToHttp().getRequest<GuardRequest>();

    const isPublic =
      this.reflector.getAllAndOverride<boolean>(META_PUBLIC, targets) === true ||
      this.isPublicPath(request.url ?? '');
    const required = this.reflector.getAllAndOverride<string[]>(META_PERMISSIONS, targets) ?? [];
    const strategyName =
      this.reflector.getAllAndOverride<AuthStrategyName>(META_STRATEGY, targets) ?? this.options.strategy;

    // 1) 解析身份
    let identity: StrategyIdentity | null = null;
    try {
      identity = await this.resolve(strategyName, request);
    } catch (error) {
      if (!isPublic) throw error;
      // 公开接口：凭证异常不阻塞（例如前端携带过期令牌访问登录接口）
      logger.debug('公开接口凭证解析失败，按匿名处理', { url: request.url, reason: (error as Error).message });
    }

    if (!identity) {
      if (isPublic) return true;
      throw new BizError(ErrorCode.UNAUTHORIZED, '未登录或令牌无效');
    }

    // 2) 组装请求用户（用户身份需回源校验状态并加载权限）
    const user = identity.kind === 'user' ? await this.buildUser(identity) : this.buildService(identity);

    // 3) 授权：接口所需权限码全部命中（TC-AUTH-004 越权返回 3002）
    if (!isPublic && required.length > 0 && !hasAllPermissions(user.permissions, required)) {
      logger.warn('权限不足，拒绝访问', {
        userId: user.id,
        via: user.via,
        url: request.url,
        method: request.method,
        required,
        owned: user.permissions.length,
      });
      throw new BizError(ErrorCode.FORBIDDEN, '无操作权限');
    }

    // 4) 写请求对象与日志上下文（审计与数据权限据此取操作人）
    request.user = user;
    patchRequestContext({ userId: user.id });
    return true;
  }

  /**
   * 判断是否为免认证路径（探针 / 指标；前缀匹配，忽略查询串）
   * @param url 请求 URL（可能带查询串）
   */
  private isPublicPath(url: string): boolean {
    if (!url) return false;
    const path = url.split('?')[0];
    return this.options.publicPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  }

  /** 选择策略并解析身份 */
  private async resolve(name: AuthStrategyName, request: GuardRequest): Promise<StrategyIdentity | null> {
    const strategy: AuthStrategy = this.registry.get(name);
    return strategy.authenticate({
      headers: request.headers ?? {},
      ip: request.ip,
      userAgent: typeof request.headers?.['user-agent'] === 'string' ? (request.headers['user-agent'] as string) : undefined,
    });
  }

  /** 用户身份 → RequestUser（校验存在性与账号状态，加载角色/权限/数据范围） */
  private async buildUser(identity: StrategyIdentity): Promise<RequestUser> {
    const user = await this.store.findUserById(identity.id);
    if (!user) throw new BizError(ErrorCode.UNAUTHORIZED, '账号不存在或已注销');
    if (user.status !== 1) {
      logger.warn('账号状态不可用，拒绝访问', { userId: user.id, status: user.status });
      throw new BizError(ErrorCode.ACCOUNT_LOCKED, '账号已禁用，请联系管理员');
    }
    const context = await this.permissions.getUserContext(user.id);
    return {
      id: user.id,
      username: user.username,
      roles: context.roles,
      permissions: context.permissions,
      dataScope: context.dataScope,
      via: identity.via,
      jti: identity.jti,
      tokenType: identity.tokenType,
      fam: identity.fam,
      exp: identity.exp,
      isService: false,
    };
  }

  /** 服务身份（API Key / OAuth2 客户端）→ RequestUser */
  private buildService(identity: StrategyIdentity): RequestUser {
    return {
      id: identity.id,
      username: identity.username,
      roles: [],
      permissions: identity.permissions ?? [],
      dataScope: identity.dataScope ?? 'all',
      via: identity.via,
      isService: true,
    };
  }
}

/** 权限码全命中判定（守卫与业务层共用同一语义） */
function hasAllPermissions(owned: string[], required: string[]): boolean {
  if (required.length === 0) return true;
  const set = new Set(owned);
  return required.every((code) => set.has(code));
}

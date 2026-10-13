/*
 * @file 鉴权装饰器
 * @description PRD-003 FR-05：`@Public()` 放行、`@Permissions('order:refund')` 声明接口所需权限码、
 *   `@AuthStrategy('apikey')` 覆盖路由认证方式（TC-AUTH-012 多策略共存）、
 *   `@CurrentUser()` 注入当前请求用户、`@Audit()` 声明审计元信息（由 AuditInterceptor 消费）。
 *   装饰器只写元数据，判定逻辑统一在 RbacGuard / AuditInterceptor，避免散落判断。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { META_AUDIT, META_PERMISSIONS, META_PUBLIC, META_STRATEGY } from './constants.js';
import type { AuditAction, AuthStrategyName, RequestUser } from './types.js';

/**
 * 放行无需登录的接口（登录、注册、刷新、健康检查）
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(META_PUBLIC, true);

/**
 * 声明接口所需权限码（全部命中才通过；与 permissions.code 同源）
 * @param codes 权限码，如 `@Permissions('order:refund')`
 */
export const Permissions = (...codes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(META_PERMISSIONS, codes);

/**
 * 覆盖该路由的认证策略（默认取 AUTH_STRATEGY）
 * @param name 策略名：jwt / session / oauth2 / apikey
 */
export const AuthStrategy = (name: AuthStrategyName): MethodDecorator & ClassDecorator =>
  SetMetadata(META_STRATEGY, name);

/** 审计元信息 */
export interface AuditMeta {
  /** 模块名（写入 audit_logs.module） */
  module: string;
  /** 动作 */
  action: AuditAction;
  /** 对象类型（写入 audit_logs.target_type） */
  targetType?: string;
  /** 从路由参数取对象 ID 的参数名，默认 id */
  idParam?: string;
}

/**
 * 声明审计元信息：命中后由全局拦截器自动落库（操作人 / IP / 入参 / 返回值）
 * @param meta 模块、动作与对象类型
 */
export const Audit = (meta: AuditMeta): MethodDecorator => SetMetadata(META_AUDIT, meta);

/** 从请求用户中取值（@CurrentUser 的取值逻辑，抽成纯函数便于单测） */
export function pickUser(user: RequestUser | undefined, key?: keyof RequestUser): RequestUser | RequestUser[keyof RequestUser] | undefined {
  if (!user) return undefined;
  return key ? user[key] : user;
}

/**
 * 注入当前请求用户（由 RbacGuard 写入）
 * @param key 可选：取 RequestUser 的某个字段，如 `@CurrentUser('id')`
 */
export const CurrentUser = createParamDecorator((key: keyof RequestUser | undefined, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<{ user?: RequestUser }>();
  return pickUser(request.user, key);
});

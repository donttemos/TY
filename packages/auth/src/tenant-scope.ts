/*
 * @file 租户范围解析（与 dataScope 正交的第二个隔离维度）
 * @description PRD-008 FR-02 / TC-TNT-001：共享库（shared）下同表数据靠 `tenant_id` 区分，
 *   **租户范围与归属人范围（dataScope）是两个不同维度**，必须分别收敛：
 *   - dataScope 回答「能看谁的数据」（本人 / 本部门 / 部门及下级 / 不限）；
 *   - 租户范围回答「能看哪个租户的数据」，服务端强制，客户端传入的 `tenant_id` 只能收窄、不能放大。
 *   典型越权：某租户内 dataScope=all 的用户并非平台级身份，若查询不强制当前租户，
 *   他可通过 `tenant_id=<其他租户>` 或直接猜记录 ID 越出本租户边界——`all` 只解除归属人限制，
 *   解除不了租户边界。
 *
 *   唯一豁免是本文件 `crossTenant` 的**显式跨租户维护入口**：路由标 `@IgnoreTenant()` 且调用方
 *   持有 `system:tenant:ignore`（由 RbacGuard 校验并写豁免审计）后，守卫才会把 `ignoreTenant`
 *   写入请求上下文。本解析器据此放开租户约束，此时才允许按调用方给的 `tenant_id` 做全局检索。
 * @author donttemo
 * @created 2026-10-21
 * @module @fw/auth
 */

import { BizError, ErrorCode } from '@fw/core';
import { getRequestContext } from '@fw/logger';
import type { ID, RequestUser } from './types.js';

/**
 * 租户范围（服务端解析结果）
 *
 * `tenantId = null` 有两种来源，调用方必须用 `crossTenant` 区分：
 * - `crossTenant = true`：已授权的跨租户维护入口（全局访问，可选按 `tenant_id` 收窄）；
 * - `crossTenant = false`：legacy / 单租户部署没有租户上下文（无租户边界，保持既有行为）。
 */
export interface TenantScope {
  /** 强制租户 ID；`null` 表示不注入租户条件（见上方两种来源） */
  tenantId: ID | null;
  /** 是否已授权的跨租户维护入口（RbacGuard 校验 system:tenant:ignore 后写入上下文） */
  crossTenant: boolean;
}

/** 解析所需的请求上下文最小面（默认读 @fw/logger 的 ALS 上下文，测试可显式注入） */
export interface TenantScopeContext {
  /** 解析中间件 + 鉴权守卫共同确认的当前租户 ID（十进制字符串，'0' = legacy 存量租户） */
  tenantId?: string;
  /** 仅由 RbacGuard 在 @IgnoreTenant 路由且持有 system:tenant:ignore 时写入 */
  ignoreTenant?: boolean;
}

/**
 * 解析当前请求的租户范围
 *
 * 优先级：已授权跨租户维护 → 请求上下文租户（服务端解析并校验存在）→ 用户档案租户。
 * 用户档案租户只作兜底：上下文缺失（单租户模式 / 非 HTTP 调用）时仍按用户归属收敛，
 * 避免「有租户归属的用户在无上下文路径上看到全租户数据」。
 *
 * @param user 当前请求用户（至少含 tenantId）
 * @param context 请求上下文；缺省读 ALS（测试可注入）
 * @returns 租户范围
 */
export function resolveTenantScope(
  user: Pick<RequestUser, 'tenantId'>,
  context: TenantScopeContext | undefined = getRequestContext(),
): TenantScope {
  // 维护入口：守卫已在放行前校验 system:tenant:ignore 并写豁免审计，此处不再重复判权
  if (context?.ignoreTenant === true) return { tenantId: null, crossTenant: true };
  // 上下文租户是「服务端解析 + 守卫比对」过的事实（含 legacy '0'）；缺失时回退用户档案，
  // 保证单租户模式/后台调用仍有归属边界。注意不能用 falsy 判断——'0' 是合法的 legacy 租户。
  const fromContext = typeof context?.tenantId === 'string' && context.tenantId !== '' ? context.tenantId : undefined;
  const fromUser = typeof user.tenantId === 'string' && user.tenantId !== '' ? user.tenantId : undefined;
  return { tenantId: fromContext ?? fromUser ?? null, crossTenant: false };
}

/**
 * 计算本次查询实际生效的租户过滤条件
 *
 * 规则（服务端强制）：
 * 1. 跨租户维护入口：调用方给的 `tenant_id` 只作可选收窄，缺省即「全部租户」；
 * 2. 普通租户请求：强制使用服务端解析出的当前租户；调用方若显式指定了**另一个**租户，
 *    直接 4001 拒绝（不静默改写、也不退化为空结果——显式跨租户尝试要被看见）；
 * 3. 无租户边界（legacy 单租户）：不注入条件（调用方的过滤只作收窄）。
 *
 * @param scope resolveTenantScope 的结果
 * @param requestedTenantId 客户端 `tenant_id` 参数（已做十进制校验）
 * @returns 传给存储层的租户过滤值；`undefined` 表示不过滤
 * @throws BizError 4001 客户端租户与服务端当前租户不一致
 */
export function resolveTenantFilter(scope: TenantScope, requestedTenantId?: string): string | undefined {
  // 维护入口：可选按租户检索（全局访问行为只在此路径成立）
  if (scope.crossTenant) return requestedTenantId;
  // 无租户边界（legacy 单租户）：服务端没有可强制的租户，客户端过滤只作收窄，不可能放大
  if (scope.tenantId === null) return requestedTenantId;
  if (requestedTenantId !== undefined && requestedTenantId !== scope.tenantId) {
    throw new BizError(ErrorCode.TENANT_INVALID, '租户条件与服务端当前租户不一致，禁止跨租户查询');
  }
  return scope.tenantId;
}

/**
 * 单条记录是否落在当前租户范围内（详情 / 写操作的 fail-closed 判定，纯函数）
 *
 * 与 `isActorWithinDataScope` 并列使用：详情必须**同时**通过归属人范围与租户归属两道校验。
 * @param scope resolveTenantScope 的结果
 * @param recordTenantId 记录落库时的租户 ID（存量行 '0' 语义为「未知/存量」）
 * @returns 是否可见
 */
export function isTenantWithinScope(scope: TenantScope, recordTenantId: ID | null | undefined): boolean {
  if (scope.crossTenant) return true;
  if (scope.tenantId === null) return true;
  return recordTenantId === scope.tenantId;
}

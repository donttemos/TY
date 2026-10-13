/*
 * @file 数据权限（dataScope）过滤解析
 * @description PRD-003 FR-10 / PRD-008 FR-04/FR-05：四档数据范围
 *   （全部 all / 本组织及下级 org_below / 本组织 org / 仅本人 self）的统一解析入口。
 *   - `resolveDataScope`：纯同步判定，org/org_below 无组织信息时按最小权限收敛为 self
 *     （标记 pendingScopes），用于不注入组织端口的场景；
 *   - `resolveDataScopeFilter`：完整解析（可注入 DataScopeOrgPort），控制器默认使用；
 *   - `assertWithinDataScope`：详情/写操作越权校验，范围外目标一律 3002（fail-closed）。
 *   默认安全：无法识别、未实现、用户无部门归属的范围一律按 self 收敛，绝不静默放宽。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo M8 T-M8-04：org/org_below 随组织架构落地——新增 DataScopeOrgPort 端口、
 *   resolveDataScopeFilter 异步四档解析与 assertWithinDataScope 详情校验（TC-TNT-004）
 * @module @fw/auth
 */

import { BizError, ErrorCode } from '@fw/core';
import type { DataScope, ID, RequestUser } from './types.js';

/** 数据范围过滤结果 */
export interface DataScopeFilter {
  /** 生效范围 */
  scope: DataScope;
  /** 是否只能看到本人数据 */
  selfOnly: boolean;
  /** 仅本人时的归属人 ID；非 self 时为 null */
  ownerId: ID | null;
  /** 是否为「全部数据」 */
  unrestricted: boolean;
  /** org / org_below 生效时的可见部门 ID 集合（列表查询按此过滤）；非 org 档为 null */
  departmentIds: ID[] | null;
  /** 范围未能按组织解析（缺端口或用户无部门归属），已按 self 收敛，调用方应记录告警 */
  pendingScopes: DataScope[];
}

/**
 * 数据范围组织解析端口（PRD-008 FR-05）：由业务侧实现，框架不感知部门表结构。
 * 实现方通常与 AuthStore 为同一对象（见 example-api 的 PrismaAuthStore）。
 */
export interface DataScopeOrgPort {
  /** 用户所属部门 ID 列表（未分配返回空数组） */
  listDepartmentIdsByUserId(userId: ID): Promise<ID[]>;
  /**
   * 用户可见部门 ID 集合：
   * - `org`：本人所在部门（多部门取并集）；
   * - `org_below`：所在部门及全部下级（闭包）。
   * 用户无部门归属时返回空数组（调用方按 self 收敛）。
   */
  listVisibleDepartmentIds(userId: ID, scope: 'org' | 'org_below'): Promise<ID[]>;
  /** 指定部门集合内的用户 ID（去重；审计等按人过滤的场景使用；空集合返回空数组） */
  listUserIdsByDepartmentIds(departmentIds: ID[]): Promise<ID[]>;
}

/**
 * 纯同步解析：不查询组织数据时的数据范围判定。
 * org / org_below 在此按最小权限收敛为 self 并标记 pendingScopes——
 * 需要完整四档语义的调用方应改用 `resolveDataScopeFilter` 并注入组织端口。
 * @param user 当前请求用户（至少含 id 与 dataScope）
 * @returns 过滤结果
 */
export function resolveDataScope(user: Pick<RequestUser, 'id' | 'dataScope'>): DataScopeFilter {
  const scope = user.dataScope ?? 'self';
  switch (scope) {
    case 'all':
      return { scope, selfOnly: false, ownerId: null, unrestricted: true, departmentIds: null, pendingScopes: [] };
    case 'self':
      return selfFilter(user.id);
    case 'org':
    case 'org_below':
      // 无组织端口：按最小权限收敛为 self，并标记待组织解析（调用方记录告警）
      return { ...selfFilter(user.id), pendingScopes: [scope] };
    default:
      return selfFilter(user.id);
  }
}

/**
 * 完整解析四档数据范围（PRD-008 FR-04）：注入组织端口后 org / org_below 生效。
 * @param user 当前请求用户（至少含 id 与 dataScope）
 * @param org 组织解析端口；不传时 org/org_below 按 self 收敛（同 resolveDataScope）
 * @returns 过滤结果；org 档生效时 departmentIds 为可见部门集合
 */
export async function resolveDataScopeFilter(
  user: Pick<RequestUser, 'id' | 'dataScope'>,
  org?: DataScopeOrgPort,
): Promise<DataScopeFilter> {
  const scope = user.dataScope ?? 'self';
  if (scope === 'all') {
    return { scope, selfOnly: false, ownerId: null, unrestricted: true, departmentIds: null, pendingScopes: [] };
  }
  if (scope === 'self') return selfFilter(user.id);
  if (scope === 'org' || scope === 'org_below') {
    if (!org) return { ...selfFilter(user.id), pendingScopes: [scope] };
    const departmentIds = await org.listVisibleDepartmentIds(user.id, scope);
    // 用户无部门归属：放大会导致全量可见，必须收敛为 self（fail-closed）
    if (departmentIds.length === 0) return { ...selfFilter(user.id), pendingScopes: [scope] };
    return { scope, selfOnly: false, ownerId: null, unrestricted: false, departmentIds, pendingScopes: [] };
  }
  return selfFilter(user.id);
}

/**
 * 详情 / 写操作越权校验（PRD-008 FR-04「作用于列表查询与详情校验」）：
 * 目标归属人不在生效数据范围内时抛 3002，绝不静默放行。
 * @param user 当前请求用户
 * @param targetOwnerId 目标数据的归属人 ID
 * @param org 组织解析端口（org / org_below 档必需；缺失时按 self 收敛）
 * @throws BizError 3002 目标在数据范围外
 */
export async function assertWithinDataScope(
  user: Pick<RequestUser, 'id' | 'dataScope'>,
  targetOwnerId: ID,
  org?: DataScopeOrgPort,
): Promise<void> {
  const filter = await resolveDataScopeFilter(user, org);
  if (filter.unrestricted) return;
  if (filter.selfOnly) {
    if (targetOwnerId !== filter.ownerId) {
      throw new BizError(ErrorCode.FORBIDDEN, '无权访问该数据（仅本人可见）');
    }
    return;
  }
  const departmentIds = filter.departmentIds ?? [];
  const visible = departmentIds.length > 0 && org ? new Set(await org.listUserIdsByDepartmentIds(departmentIds)) : new Set<ID>();
  if (!visible.has(targetOwnerId)) {
    throw new BizError(ErrorCode.FORBIDDEN, '无权访问该数据（不在你的组织范围内）');
  }
}

/** self 档过滤结果（唯一构造点，保证三处收敛语义一致） */
function selfFilter(userId: ID): DataScopeFilter {
  return { scope: 'self', selfOnly: true, ownerId: userId, unrestricted: false, departmentIds: null, pendingScopes: [] };
}

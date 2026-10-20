/*
 * @file 数据权限（dataScope）过滤解析
 * @description PRD-003 FR-10 / PRD-008 FR-04/FR-05：四档数据范围
 *   （全部 all / 本组织及下级 org_below / 本组织 org / 仅本人 self）的统一解析入口。
 *   - `resolveDataScope`：纯同步判定，org/org_below 无组织信息时按最小权限收敛为 self
 *     （标记 pendingScopes），用于不注入组织端口的场景；
 *   - `resolveDataScopeFilter`：完整解析（可注入 DataScopeOrgPort），控制器默认使用；
 *   - `resolveDataScopeActors` / `isActorWithinDataScope`：把四档解析成「允许的归属人集合」，
 *     供**列表查询与详情校验共用**（列表看不到的记录，详情也必须拿不到）；
 *   - `assertWithinDataScope`：详情/写操作越权校验，范围外目标一律 3002（fail-closed）。
 *   默认安全：无法识别、未实现、用户无部门归属的范围一律按 self 收敛，绝不静默放宽。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo M8 T-M8-04：org/org_below 随组织架构落地——新增 DataScopeOrgPort 端口、
 *   resolveDataScopeFilter 异步四档解析与 assertWithinDataScope 详情校验（TC-TNT-004）
 * @modified 2026-10-21 donttemo P1 越权修复：新增 resolveDataScopeActors / isActorWithinDataScope——
 *   审计详情原先只判 selfOnly，org / org_below 档可凭 ID 直读范围外记录；改为与列表共用同一份
 *   归属人集合计算（assertWithinDataScope 同步复用，语义不变）
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
 * 数据范围的「允许归属人集合」（列表查询与详情校验共用）
 *
 * 列表把它翻译成 `userId` / `userIds` 查询条件，详情用 `isActorWithinDataScope` 判定单条
 * 记录是否落在同一集合里——**两处必须共用同一次计算**，否则列表看不见的记录仍可凭 ID 直读
 * （P1：审计详情曾只判 selfOnly，org / org_below 档形同虚设）。
 */
export interface DataScopeActorSet {
  /** 生效范围（org / org_below 因缺端口或无部门归属而收敛时如实记为 'self'） */
  scope: DataScope;
  /** 是否不限归属人（all 档） */
  unrestricted: boolean;
  /**
   * 允许的归属人集合：`null` 表示不限（all 档）；空数组表示「无任何可见归属人」，
   * 调用方必须按空集合收敛（例如列表 `userIds: []`、详情一律拒绝），绝不放宽为全量。
   */
  allowedUserIds: ID[] | null;
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
 * 把四档数据范围解析成「允许的归属人集合」（列表查询与详情校验的唯一计算入口）
 *
 * - all：`allowedUserIds = null`（不限）；
 * - self：`[本人]`（无部门归属的 org / org_below 也在这里收敛为 self）；
 * - org / org_below：可见部门集合展开成成员集合；部门无人时为空数组（fail-closed）。
 *
 * 列表侧直接把它映射成 `userIds` 条件；详情侧用 `isActorWithinDataScope` 判同一条记录的
 * 归属人是否在集合内。两者共用同一次计算，才不会出现「列表看不见、详情直读得到」的偏差。
 * @param user 当前请求用户（至少含 id 与 dataScope）
 * @param org 组织解析端口；不传时 org/org_below 按 self 收敛（同 resolveDataScopeFilter）
 * @returns 允许的归属人集合（scope 为收敛后的实际生效范围）
 */
export async function resolveDataScopeActors(
  user: Pick<RequestUser, 'id' | 'dataScope'>,
  org?: DataScopeOrgPort,
): Promise<DataScopeActorSet> {
  const filter = await resolveDataScopeFilter(user, org);
  if (filter.unrestricted) return { scope: filter.scope, unrestricted: true, allowedUserIds: null };
  if (filter.selfOnly) {
    return { scope: 'self', unrestricted: false, allowedUserIds: filter.ownerId ? [filter.ownerId] : [] };
  }
  const departmentIds = filter.departmentIds ?? [];
  // 缺端口或部门为空 → 空集合（绝不退化为「不限」）；org 档生效时部门必然非空
  const allowedUserIds = departmentIds.length > 0 && org ? await org.listUserIdsByDepartmentIds(departmentIds) : [];
  return { scope: filter.scope, unrestricted: false, allowedUserIds };
}

/**
 * 目标归属人是否在已解析的授权集合内（详情 / 写操作的 fail-closed 判定，纯函数）
 *
 * `targetOwnerId` 为 null 表示系统任务记录（无操作人）：它不属于任何人的授权集合，
 * 只有不限档（all）能看到——按人收敛的档位一律不可见。
 * @param actors resolveDataScopeActors 的结果
 * @param targetOwnerId 目标数据的归属人 ID（系统任务为 null）
 * @returns 是否可见
 */
export function isActorWithinDataScope(
  actors: DataScopeActorSet,
  targetOwnerId: ID | null | undefined,
): boolean {
  if (actors.unrestricted) return true;
  if (targetOwnerId === null || targetOwnerId === undefined) return false;
  return (actors.allowedUserIds ?? []).includes(targetOwnerId);
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
  // 与列表 / 详情共用同一份归属人集合计算（P1：独立实现会让三处语义各自漂移）
  const actors = await resolveDataScopeActors(user, org);
  if (isActorWithinDataScope(actors, targetOwnerId)) return;
  throw new BizError(
    ErrorCode.FORBIDDEN,
    actors.scope === 'self' ? '无权访问该数据（仅本人可见）' : '无权访问该数据（不在你的组织范围内）',
  );
}

/** self 档过滤结果（唯一构造点，保证三处收敛语义一致） */
function selfFilter(userId: ID): DataScopeFilter {
  return { scope: 'self', selfOnly: true, ownerId: userId, unrestricted: false, departmentIds: null, pendingScopes: [] };
}

/*
 * @file 数据权限（dataScope）过滤解析
 * @description PRD-003 FR-10：四档数据范围中 M3 仅实现「仅本人（self）」，其余三档保留判定入口，
 *   由 M8 随组织架构（departments）扩展——届时只需在此处补分支与 @fw/db 的查询条件，
 *   业务层（守卫/服务/控制器）无需改动。默认安全：无法识别或未实现的范围一律按 self 收敛。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

import type { DataScope, ID, RequestUser } from './types.js';

/** 数据范围过滤结果 */
export interface DataScopeFilter {
  /** 生效范围 */
  scope: DataScope;
  /** 是否只能看到本人数据（M3 唯一实现的档位） */
  selfOnly: boolean;
  /** 仅本人时的归属人 ID；非 self 时为 null */
  ownerId: ID | null;
  /** 是否为「全部数据」 */
  unrestricted: boolean;
  /** 尚未实现、需要 M8 组织架构支持的范围（返回时按 self 收敛，并由调用方记录告警） */
  pendingScopes: DataScope[];
}

/**
 * 解析用户的数据范围过滤条件
 * @param user 当前请求用户（至少含 id 与 dataScope）
 * @returns 过滤结果
 */
export function resolveDataScope(user: Pick<RequestUser, 'id' | 'dataScope'>): DataScopeFilter {
  const scope = user.dataScope ?? 'self';
  switch (scope) {
    case 'all':
      return { scope, selfOnly: false, ownerId: null, unrestricted: true, pendingScopes: [] };
    case 'self':
      return { scope, selfOnly: true, ownerId: user.id, unrestricted: false, pendingScopes: [] };
    case 'org':
    case 'org_below':
      // M8 扩展点：需要 departments / user_department 参与，M3 按最小权限收敛为 self
      return { scope: 'self', selfOnly: true, ownerId: user.id, unrestricted: false, pendingScopes: [scope] };
    default:
      return { scope: 'self', selfOnly: true, ownerId: user.id, unrestricted: false, pendingScopes: [] };
  }
}

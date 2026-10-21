/*
 * @file 平台审计租户选项端点（P2 评审补口）
 * @description 锁定 `GET /audit-logs/platform/tenant-options` 的服务端契约：
 *   ① 它是**跨租户维护入口**——必须带 `@IgnoreTenant()`（守卫据此要求 system:tenant:ignore 并写
 *      豁免审计），且业务权限只需 `audit:read`，**不要求 `tenant:read`**（专职审计角色不应被迫
 *      获得租户管理面读取权限）；
 *   ② 参数收敛：keyword 去空白并截断、page/pageSize 夹取、ids 逗号解析 + 上限 100，非法 ids 400；
 *   ③ 返回只透传 AdminStore 的最小投影（id/code/name/status），不在控制器层扩展管理面字段；
 *   ④ ids 与 keyword 同时给出时 ids 优先（列表行名称解析场景不能被搜索词带偏）。
 * @author donttemo
 * @created 2026-10-21
 * @module example-api/auth
 */
import { describe, expect, it } from 'vitest';
import { BizError, ErrorCode } from '@fw/core';
import { META_IGNORE_TENANT, META_PERMISSIONS } from '@fw/auth';
import type { DataScopeOrgPort, RequestUser } from '@fw/auth';
import { AuditController } from './audit.controller.js';
import type { AdminStore, TenantOptionQuery } from '../admin/admin-store.js';
import type { JobCenterService } from '../jobs/job-center.service.js';
import type { JobRunnerRegistry } from '../jobs/job-runner.registry.js';

/** 只要不抛错即可的依赖桩（本用例只关心租户选项端点） */
const NOOP = {};

/** 最小可用的 AdminStore 桩：捕获查询并返回固定行 */
function createHarness(): { controller: AuditController; captured: TenantOptionQuery[] } {
  const captured: TenantOptionQuery[] = [];
  const admin = {
    listTenantOptions: async (query: TenantOptionQuery) => {
      captured.push(query);
      return {
        items: [
          { id: '1', code: 'acme', name: 'ACME 公司', status: 1 },
          { id: '2', code: 'off', name: '已停用租户', status: 0 },
        ].slice(0, query.ids && query.ids.length > 0 ? 1 : 2),
        total: 2,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
        hasMore: false,
      };
    },
  } as unknown as AdminStore;
  const controller = new AuditController(
    NOOP as never,
    NOOP as DataScopeOrgPort,
    admin,
    NOOP as unknown as JobCenterService,
    { register: () => undefined } as unknown as JobRunnerRegistry,
    NOOP as never,
  );
  return { controller, captured };
}

/** 非终点请求参数（端点只用 query，直接给空对象即可） */
const USER = { id: 'u-admin', tenantId: '0' } as RequestUser;

describe('平台审计租户选项（受控查询）', () => {
  it('路由元数据：跨租户维护入口 + 仅 audit:read（不要求 tenant:read）', () => {
    const handler = AuditController.prototype.platformTenantOptions;
    expect(Reflect.getMetadata(META_IGNORE_TENANT, handler)).toBe(true);
    expect(Reflect.getMetadata(META_PERMISSIONS, handler)).toEqual(['audit:read']);
  });

  it('keyword 搜索：去空白 + 截断 64；page/pageSize 按上限与下限夹取', async () => {
    const { controller, captured } = createHarness();
    await controller.platformTenantOptions(`  acme  ${'x'.repeat(80)}`, undefined, '0', '1000');
    expect(captured[0]).toMatchObject({ keyword: `acme  ${'x'.repeat(58)}`, page: 1, pageSize: 100 });
    expect(captured[0].ids).toBeUndefined();
  });

  it('ids 批量解析：逗号分隔 + 去非法项 + 截断 100，与 keyword 同时给出时 ids 优先', async () => {
    const { controller, captured } = createHarness();
    const ids = Array.from({ length: 120 }, (_, index) => String(index + 1)).join(',');
    await controller.platformTenantOptions('acme', `${ids},abc,`, '2', '20');
    expect(captured[0].keyword).toBeUndefined();
    expect(captured[0].ids).toHaveLength(100);
    expect(captured[0].ids?.[0]).toBe('1');
    expect(captured[0].page).toBe(2);
  });

  it('ids 全部非法 → 400（不静默退化成全部租户）', async () => {
    const { controller } = createHarness();
    const capture = async (run: () => Promise<unknown>): Promise<BizError> => {
      try {
        await run();
      } catch (caught) {
        return caught as BizError;
      }
      throw new Error('应抛出 BizError');
    };
    const nonNumeric = await capture(() => controller.platformTenantOptions(undefined, 'acme,off', '1', '20'));
    expect(nonNumeric).toBeInstanceOf(BizError);
    expect(nonNumeric.code).toBe(ErrorCode.BAD_REQUEST);
    const empty = await capture(() => controller.platformTenantOptions(undefined, '', '1', '20'));
    expect(empty).toBeInstanceOf(BizError);
    expect(empty.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('空 keyword 不向下传（避免退化成 "匹配空串" 的全量模糊查询）', async () => {
    const { controller, captured } = createHarness();
    await controller.platformTenantOptions('   ', undefined, '1', '20');
    expect(captured[0].keyword).toBeUndefined();
    expect(captured[0]).toMatchObject({ page: 1, pageSize: 20 });
  });
});

/*
 * @file 租户范围解析单测（PRD-008 FR-02 / PRD-015 FR-15-20 / TC-TNT-001）
 * @description 锁定「租户维度与 dataScope 正交」的三条不变量：
 *   1. resolveTenantScope：普通请求取服务端上下文租户（'0' legacy 不可被 falsy 吞掉），
 *      上下文缺失回退用户档案租户；只有 ignoreTenant（守卫校验 system:tenant:ignore 后写入）才跨租户；
 *   2. resolveTenantFilter：客户端 tenant_id 只能收窄不能放大——与当前租户不一致直接 4001，
 *      维护入口才允许按任意 tenant_id 检索；
 *   3. isTenantWithinScope：详情按记录 tenantId 判定，跨租户维护入口全局放行，无租户边界保持既有行为。
 * @author donttemo
 * @created 2026-10-21
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { BizError, ErrorCode } from '@fw/core';
import {
  isTenantWithinScope,
  resolveTenantFilter,
  resolveTenantScope,
  type TenantScope,
} from '../tenant-scope.js';

/** 捕获 BizError（未抛出即用例失败） */
function captureError(fn: () => unknown): BizError {
  try {
    fn();
  } catch (error) {
    return error as BizError;
  }
  throw new Error('应抛出 BizError（普通租户请求显式指定他租户必须 fail-closed）');
}

describe('resolveTenantScope · 服务端优先的租户来源', () => {
  it('请求上下文租户优先于用户档案（守卫已比对两者，上下文是解析中间件的服务端事实）', () => {
    expect(resolveTenantScope({ tenantId: '17' }, { tenantId: '18' })).toEqual({ tenantId: '18', crossTenant: false });
  });

  it('上下文缺失（单租户模式 / 非 HTTP 调用）回退用户档案租户，避免无边界放大', () => {
    expect(resolveTenantScope({ tenantId: '18' }, undefined)).toEqual({ tenantId: '18', crossTenant: false });
    expect(resolveTenantScope({ tenantId: '18' }, {})).toEqual({ tenantId: '18', crossTenant: false });
  });

  it("legacy 租户 '0' 不能被 falsy 判断吞掉（存量租户同样是有边界的租户）", () => {
    expect(resolveTenantScope({ tenantId: '0' }, { tenantId: '0' })).toEqual({ tenantId: '0', crossTenant: false });
    expect(resolveTenantScope({ tenantId: '0' }, {})).toEqual({ tenantId: '0', crossTenant: false });
  });

  it('两侧都没有租户标识：无租户边界（legacy 单租户），不猜也不伪造', () => {
    expect(resolveTenantScope({}, undefined)).toEqual({ tenantId: null, crossTenant: false });
    expect(resolveTenantScope({ tenantId: '' }, { tenantId: '' })).toEqual({ tenantId: null, crossTenant: false });
  });

  it('ignoreTenant（仅守卫在 @IgnoreTenant + system:tenant:ignore 校验通过后写入）才跨租户', () => {
    expect(resolveTenantScope({ tenantId: '17' }, { tenantId: '17', ignoreTenant: true })).toEqual({
      tenantId: null,
      crossTenant: true,
    });
  });
});

describe('resolveTenantFilter · 客户端 tenant_id 只能收窄', () => {
  const scoped: TenantScope = { tenantId: '17', crossTenant: false };
  const maintenance: TenantScope = { tenantId: null, crossTenant: true };
  const legacy: TenantScope = { tenantId: null, crossTenant: false };

  it('普通请求：未指定 tenant_id 时强制使用服务端当前租户', () => {
    expect(resolveTenantFilter(scoped)).toBe('17');
  });

  it('普通请求：tenant_id 与当前租户一致时照常放行（同值不产生副作用）', () => {
    expect(resolveTenantFilter(scoped, '17')).toBe('17');
  });

  it('普通请求：显式指定其他租户 → 4001 拒绝（不静默改写，也不退化成空结果）', () => {
    const error = captureError(() => resolveTenantFilter(scoped, '18'));
    expect(error).toBeInstanceOf(BizError);
    expect(error.code).toBe(ErrorCode.TENANT_INVALID);
    expect(error.code).toBe(4001);
  });

  it("普通请求：请求 legacy '0' 而当前租户是 '17' 同样拒绝（客户端不能挑租户）", () => {
    expect(captureError(() => resolveTenantFilter(scoped, '0')).code).toBe(ErrorCode.TENANT_INVALID);
  });

  it('跨租户维护入口：tenant_id 可选（缺省 = 全部租户；给出即收窄）', () => {
    expect(resolveTenantFilter(maintenance)).toBeUndefined();
    expect(resolveTenantFilter(maintenance, '18')).toBe('18');
  });

  it('无租户边界（legacy 单租户）：服务端无强制值，客户端过滤只作收窄', () => {
    expect(resolveTenantFilter(legacy)).toBeUndefined();
    expect(resolveTenantFilter(legacy, '18')).toBe('18');
  });
});

describe('isTenantWithinScope · 详情租户归属判定', () => {
  const scoped: TenantScope = { tenantId: '17', crossTenant: false };
  const maintenance: TenantScope = { tenantId: null, crossTenant: true };
  const legacy: TenantScope = { tenantId: null, crossTenant: false };

  it('普通请求：仅同租户记录可见（其他租户 / 未知存量 0 / 缺失均为 false）', () => {
    expect(isTenantWithinScope(scoped, '17')).toBe(true);
    expect(isTenantWithinScope(scoped, '18')).toBe(false);
    expect(isTenantWithinScope(scoped, '0')).toBe(false);
    expect(isTenantWithinScope(scoped, null)).toBe(false);
    expect(isTenantWithinScope(scoped, undefined)).toBe(false);
  });

  it("legacy 租户 '0'：记录同为 '0' 时可见，其他租户仍不可见", () => {
    const legacyScoped: TenantScope = { tenantId: '0', crossTenant: false };
    expect(isTenantWithinScope(legacyScoped, '0')).toBe(true);
    expect(isTenantWithinScope(legacyScoped, '17')).toBe(false);
  });

  it('跨租户维护入口：全局放行（含未知存量 0 / 缺失）', () => {
    for (const tenantId of ['0', '17', '18', null, undefined]) {
      expect(isTenantWithinScope(maintenance, tenantId)).toBe(true);
    }
  });

  it('无租户边界（legacy 单租户）：保持既有行为（不新增拒绝面）', () => {
    expect(isTenantWithinScope(legacy, '17')).toBe(true);
    expect(isTenantWithinScope(legacy, null)).toBe(true);
  });
});

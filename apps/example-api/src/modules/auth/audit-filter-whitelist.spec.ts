/*
 * @file 审计过滤参数白名单契约（PRD-012 OBS-14 反向验证）
 * @description 未知过滤参数必须 400 / 1001（不静默忽略，列表参数白名单解析既有约定）：
 *   合法参数（含 M12 新增 trace_id/request_id/family_id/category/event）放行；
 *   白名单外字段报错且消息列出允许清单；与 mock 侧 unknownMockAuditFilterParam 同语义（N-02）。
 * @author donttemo
 * @created 2026-10-17
 * @module example-api/auth
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_FILTER_PARAMS, assertKnownFilterParams, parseAuditEvents, parseAuditResult, parseTenantId } from './audit.controller.js';
import { BizError } from '@fw/core';

describe('M12 W2 · 审计过滤参数白名单（OBS-14 反向验证）', () => {
  it('合法过滤参数（含新增五项）全部放行', () => {
    expect(() =>
      assertKnownFilterParams({
        page: '1',
        pageSize: '20',
        user_id: 'u-1',
        module: 'auth',
        action: 'login',
        target_type: 'user',
        target_id: 'u-1',
        from: '2026-10-01',
        to: '2026-10-17',
        sort: 'created_at:desc',
        trace_id: 't-1',
        request_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        family_id: 'fam-1',
        category: 'security',
        event: 'refresh.replay_detected',
      }),
    ).not.toThrow();
    expect(AUDIT_FILTER_PARAMS).toContain('trace_id');
    expect(AUDIT_FILTER_PARAMS).toContain('request_id');
    expect(AUDIT_FILTER_PARAMS).toContain('family_id');
    expect(AUDIT_FILTER_PARAMS).toContain('category');
    expect(AUDIT_FILTER_PARAMS).toContain('event');
  });

  it('白名单外过滤字段抛 400/1001，消息含字段名与允许清单', () => {
    try {
      assertKnownFilterParams({ user_id: 'u-1', hack_field: 'x' });
      expect.unreachable('应抛出 BizError');
    } catch (error) {
      expect(error).toBeInstanceOf(BizError);
      expect((error as BizError).code).toBe(1001);
      expect((error as Error).message).toContain('hack_field');
      expect((error as Error).message).toContain('trace_id');
    }
  });

  it('PRD-015 新增 result / tenant_id 在白名单内，且取值经过校验（非法即 400）', () => {
    expect(() => assertKnownFilterParams({ result: 'denied', tenant_id: '1024' })).not.toThrow();
    expect(AUDIT_FILTER_PARAMS).toContain('result');
    expect(AUDIT_FILTER_PARAMS).toContain('tenant_id');

    expect(parseAuditResult('denied')).toBe('denied');
    expect(parseAuditResult('unknown')).toBe('unknown');
    expect(parseAuditResult(undefined)).toBeUndefined();
    expect(() => parseAuditResult('done')).toThrowError(/非法 result/);

    expect(parseTenantId('1024')).toBe('1024');
    expect(parseTenantId('0')).toBe('0');
    expect(parseTenantId(undefined)).toBeUndefined();
    expect(() => parseTenantId('tenant-a')).toThrowError(/非法 tenant_id/);
  });

  it('event 支持逗号分隔多值（风险筛选展开）：去空去重，上限 20', () => {
    expect(parseAuditEvents('a.b.c,d.e.f')).toEqual(['a.b.c', 'd.e.f']);
    expect(parseAuditEvents(' a.b.c , ,a.b.c ')).toEqual(['a.b.c']);
    expect(parseAuditEvents(undefined)).toBeUndefined();
    expect(parseAuditEvents(' , ')).toBeUndefined();
    const many = Array.from({ length: 21 }, (_, index) => `e.v${index}`).join(',');
    expect(() => parseAuditEvents(many)).toThrowError(/多值上限 20/);
  });
});

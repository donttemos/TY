/*
 * @file biz-error 单元测试
 * @description 覆盖错误码语义（3001/3003 触发无感刷新、3004 跳登录）、toBizError 对 null data 与
 *   缺省 code 的容忍、字段级 details 提取、describeBizError 的用户可读提示（含 9001 traceId）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/utils
 */

import { describe, expect, it } from 'vitest';
import { BIZ_CODE, BizError, describeBizError, toBizError } from '../biz-error';

describe('BizError 错误码语义', () => {
  it('3001 未登录与 3003 过期触发无感刷新，3002 越权不触发', () => {
    expect(new BizError(BIZ_CODE.UNAUTHORIZED, '').shouldTryRefresh).toBe(true);
    expect(new BizError(BIZ_CODE.TOKEN_EXPIRED, '').shouldTryRefresh).toBe(true);
    expect(new BizError(BIZ_CODE.FORBIDDEN, '').shouldTryRefresh).toBe(false);
    expect(new BizError(BIZ_CODE.INTERNAL, '').shouldTryRefresh).toBe(false);
  });

  it('3004 账号锁定跳登录，3001 不跳（先尝试刷新）', () => {
    expect(new BizError(BIZ_CODE.ACCOUNT_LOCKED, '').shouldRedirectLogin).toBe(true);
    expect(new BizError(BIZ_CODE.UNAUTHORIZED, '').shouldRedirectLogin).toBe(false);
  });
});

describe('toBizError 信封解析', () => {
  it('data 为 null 与 code 缺省时不抛错（code 回落 9001）', () => {
    const error = toBizError({ code: undefined, message: '刷新失败', data: null });
    expect(error).toBeInstanceOf(BizError);
    expect(error.code).toBe(BIZ_CODE.INTERNAL);
    expect(error.details).toBeNull();
    expect(error.message).toBe('刷新失败');
  });

  it('提取字段级 details（1001 参数校验）', () => {
    const error = toBizError({ code: BIZ_CODE.BAD_REQUEST, data: { details: [{ field: 'username', message: '必填' }] } });
    expect(error.details).toHaveLength(1);
    expect(error.details?.[0]?.field).toBe('username');
  });

  it('data.details 非数组时按无详情处理', () => {
    const error = toBizError({ code: BIZ_CODE.BUSINESS, data: { details: 'oops' } as unknown as { details: never } });
    expect(error.details).toBeNull();
  });
});

describe('describeBizError 用户可读提示', () => {
  it('9001 附带 traceId 便于报障', () => {
    const error = new BizError(BIZ_CODE.INTERNAL, '', 'trace-abc-123');
    expect(describeBizError(error)).toContain('trace-abc-123');
  });

  it('3002 越权提示「无操作权限」', () => {
    expect(describeBizError(new BizError(BIZ_CODE.FORBIDDEN, ''))).toBe('无操作权限');
  });

  it('3004 账号锁定提示联系管理员', () => {
    expect(describeBizError(new BizError(BIZ_CODE.ACCOUNT_LOCKED, ''))).toContain('管理员');
  });

  it('未知错误码回退 message 或通用提示', () => {
    expect(describeBizError(new BizError(9999, '自定义错误'))).toBe('自定义错误');
    expect(describeBizError(new BizError(9999, ''))).toBe('请求失败，请稍后重试');
  });
});

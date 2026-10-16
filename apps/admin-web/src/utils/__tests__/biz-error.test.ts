/*
 * @file biz-error 单元测试
 * @description 覆盖错误码语义（3001/3003 触发无感刷新、3004 跳登录）、toBizError 对 null data 与
 *   缺省 code 的容忍、字段级 details 提取、describeBizError 的用户可读提示（含 9001 traceId）
 *   与 E-14 双语路径（zh-CN 后端 message 优先零回归 / en-US 前端表接管）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo E-14：describeBizError locale 参数化——补 zh-CN 既有断言守卫（beforeEach
 *   复位 locale，防用例间串扰）与 en-US 表接管、5002/9001 模板插值、4001 专属文案用例
 * @module admin-web/utils
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { BIZ_CODE, BizError, describeBizError, toBizError, type BizCodeValue } from '../biz-error';
import { messages, setLocale, translate } from '@/locales';

// describeBizError 缺省 locale = currentLocale()：用例间显式复位，避免 en-US 段污染 zh-CN 段（反之亦然）
beforeEach(() => {
  setLocale('zh-CN');
});

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

describe('describeBizError 用户可读提示（zh-CN 缺省，行为零回归）', () => {
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

  it('后端 message 优先于表文案（既有语义）', () => {
    expect(describeBizError(new BizError(BIZ_CODE.BAD_REQUEST, '用户名必填'))).toBe('用户名必填');
  });

  it('5002 有 details 拼接字段级原因，无 details 回落后端 message', () => {
    const withDetails = new BizError(BIZ_CODE.CONFIG_INVALID_VALUE, '', null, [
      { field: 'value', message: '必须为 1-100 的整数' },
      { field: 'source', message: '不能为空' },
    ]);
    expect(describeBizError(withDetails)).toBe('新值非法：必须为 1-100 的整数；不能为空');
    expect(describeBizError(new BizError(BIZ_CODE.CONFIG_INVALID_VALUE, '值越界'))).toBe('值越界');
    expect(describeBizError(new BizError(BIZ_CODE.CONFIG_INVALID_VALUE, ''))).toBe('新值非法，请检查后重试');
  });

  it('4001 租户无效有专属文案（E-14 表补齐，原走通用兜底）', () => {
    expect(describeBizError(new BizError(BIZ_CODE.TENANT_INVALID, ''))).toBe('租户无效或已过期');
  });

  it('未知错误码回退 message 或通用提示', () => {
    expect(describeBizError(new BizError(9999, '自定义错误'))).toBe('自定义错误');
    expect(describeBizError(new BizError(9999, ''))).toBe('请求失败，请稍后重试');
  });
});

describe('describeBizError en-US（E-14 OQ-4：前端表接管）', () => {
  beforeEach(() => {
    setLocale('en-US');
  });

  it('表优先于后端中文 message（3002 越权）', () => {
    expect(describeBizError(new BizError(BIZ_CODE.FORBIDDEN, '无操作权限'))).toBe('You do not have permission to perform this action');
  });

  it('9001 带 traceId 走英文上报变体', () => {
    expect(describeBizError(new BizError(BIZ_CODE.INTERNAL, '', 'trace-xyz'))).toBe('Something went wrong (reported, traceId: trace-xyz)');
    expect(describeBizError(new BizError(BIZ_CODE.INTERNAL, ''))).toBe('Something went wrong. Please try again later');
  });

  it('5002 details 用英文分号拼接，无 details 走表文案', () => {
    const withDetails = new BizError(BIZ_CODE.CONFIG_INVALID_VALUE, '', null, [
      { field: 'value', message: 'must be 1-100' },
      { field: 'source', message: 'required' },
    ]);
    expect(describeBizError(withDetails)).toBe('Invalid config value: must be 1-100; required');
    // 无 details：zh-CN 才回落后端 message，en-US 由表接管
    expect(describeBizError(new BizError(BIZ_CODE.CONFIG_INVALID_VALUE, '值越界'))).toBe('Invalid config value. Please check and try again');
  });

  it('未知码仍回落后端 message 再回通用提示', () => {
    expect(describeBizError(new BizError(9999, 'custom failure'))).toBe('custom failure');
    expect(describeBizError(new BizError(9999, ''))).toBe('Request failed. Please try again later');
  });
});

describe('locale 文案表护栏（E-14：新增错误码必须同步两表）', () => {
  it('zh-CN / en-US 错误码表覆盖 BIZ_CODE 全集', () => {
    const codes = Object.values(BIZ_CODE).filter((code): code is BizCodeValue => code !== 0);
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const table = messages[locale].errors as unknown as Record<string, string>;
      for (const code of codes) {
        expect(table[code], `${locale} 缺错误码 ${code} 文案`).toBeTruthy();
      }
    }
  });

  it('两表键集一致（模板变体与兜底键同进同出）', () => {
    const zhKeys = Object.keys(messages['zh-CN'].errors).sort();
    const enKeys = Object.keys(messages['en-US'].errors).sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it('translate 缺 key 回落 zh-CN 再返回 null，{var} 插值缺变量保留原文', () => {
    expect(translate('en-US', 'errors.fallback')).toBe('Request failed. Please try again later');
    expect(translate('en-US', 'not.exist.key')).toBeNull();
    expect(translate('zh-CN', 'errors.9001Trace', { traceId: 't1' })).toBe('系统开小差了（已上报，traceId：t1）');
    expect(translate('zh-CN', 'errors.9001Trace', {})).toContain('{traceId}');
  });

  it('非法 locale 输入归一化回落 zh-CN', () => {
    expect(translate('zh-CN', 'common.language')).toBe('语言');
    // resolveLocale 经 setLocale 间接验证：非法值不落存储
    setLocale('fr-FR');
    expect(describeBizError(new BizError(BIZ_CODE.FORBIDDEN, ''))).toBe('无操作权限');
  });
});

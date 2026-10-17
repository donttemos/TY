/*
 * @file 错误码 i18n 覆盖契约（PRD-012 OBS-08：每个错误码 i18n 键存在）
 * @description 反向验证：BIZ_CODE 的每个数值码在 zh-CN / en-US 文案表 errors 段均有键
 *   （编译期由 ErrorMessages = Record<BizCodeValue, string> 同构约束，此处为运行期护栏——
 *   防止键以动态计算或 as any 方式绕过类型检查）。契约对齐 check-triway-consistency 轴 G
 *   （码表三副本同源）与本测试（码→文案可解析），共同构成「前端可解析 + i18n 键存在」闭环。
 * @author donttemo
 * @created 2026-10-17
 * @module admin-web/utils
 */
import { describe, expect, it } from 'vitest';
import { BIZ_CODE } from '@/utils/biz-error';
import { messages } from '@/locales';

describe('M12 W1 · 错误码 i18n 覆盖契约（OBS-08）', () => {
  const codes = Object.values(BIZ_CODE).filter((v) => v !== 0);

  it.each(['zh-CN', 'en-US'] as const)('%s 文案表覆盖全部 %d 个错误码', (locale) => {
    const table = messages[locale].errors as unknown as Record<string, unknown>;
    for (const code of codes) {
      expect(table[String(code)], `${locale} 缺少错误码 ${code} 的文案键`).toBeTruthy();
    }
  });

  it('special 键（9001Trace / 5002Details / fallback）在双语言均存在', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const table = messages[locale].errors as unknown as Record<string, unknown>;
      expect(table['9001Trace']).toBeTruthy();
      expect(table['5002Details']).toBeTruthy();
      expect(table.fallback).toBeTruthy();
    }
  });
});

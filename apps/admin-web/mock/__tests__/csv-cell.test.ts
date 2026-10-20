/*
 * @file mock 侧 CSV 单元格编码单测（与 @fw/auth escapeCsvCell 同源）
 * @description 用例与 `packages/auth/src/__tests__/csv.test.ts`、
 *   `apps/example-api/src/modules/auth/audit-csv.spec.ts` 保持同一组危险载荷：
 *   = + - @ 与制表符前缀、HYPERLINK / DDE / cmd 载荷、前导空白绕过、普通中文不被误伤。
 *   删除本文件的某个断言等于放行「mock 导出的文件被 Excel 求值」这条 mock↔后端差异路径。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/mock
 */
import { describe, expect, it } from 'vitest';
import { escapeCsvCell } from '../csv-cell';

describe('mock escapeCsvCell · 公式注入防护', () => {
  it('以 = + - @ 或制表符开头 → 单引号中和', () => {
    expect(escapeCsvCell('=1+1')).toBe(String.raw`"'=1+1"`);
    expect(escapeCsvCell('+1+1')).toBe('"\'+1+1"');
    expect(escapeCsvCell('-1+1')).toBe('"\'-1+1"');
    expect(escapeCsvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(escapeCsvCell('\t=1+1')).toBe('"\'\t=1+1"');
  });

  it('武器化载荷：DDE / HYPERLINK / cmd 拼接', () => {
    expect(escapeCsvCell("=cmd|' /C calc'!A0")).toBe(String.raw`"'=cmd|' /C calc'!A0"`);
    expect(escapeCsvCell('=HYPERLINK("http://evil.example","click")')).toBe(
      String.raw`"'=HYPERLINK(""http://evil.example"",""click"")"`,
    );
  });

  it('前导空白不能绕过防护', () => {
    expect(escapeCsvCell('  =1+1')).toBe(String.raw`"'  =1+1"`);
  });

  it('普通文本 / 对象快照不被改写（单元格首字符非危险符）', () => {
    expect(escapeCsvCell('示例企业')).toBe('"示例企业"');
    expect(escapeCsvCell({ note: '=1+1' })).toBe(`"{""note"":""=1+1""}"`);
  });

  it('空值形态与后端一致（空串，不是字面量 ""）', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });
});

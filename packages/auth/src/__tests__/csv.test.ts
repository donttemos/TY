/*
 * @file 审计导出 CSV 单元格编码单测（PRD-015 FR-15-19 安全加固）
 * @description 锁死三件事：
 *   ① 公式注入危险前缀（= + - @ 制表符）必须被中和，且只中和这一格、不污染其他格；
 *   ② 引号转义 / 换行压平 / 空值形态维持既有约定（Excel 打开不乱码、不串行）；
 *   ③ 未加危险前缀的普通文本与数字**不得**被改写（防护不能变成数据污染）。
 *   反向用例（删除防护后必须失败）见「公式注入防护」分组 —— 去掉 `FORMULA_TRIGGER`
 *   判断后这些断言会直接红。
 * @author donttemo
 * @created 2026-10-20
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { escapeCsvCell } from '../csv.js';

describe('escapeCsvCell · 公式注入防护', () => {
  it('以 = + - @ 开头的单元格被单引号中和（Excel 不再当成公式）', () => {
    expect(escapeCsvCell('=1+1')).toBe(String.raw`"'=1+1"`);
    expect(escapeCsvCell('+1+1')).toBe(String.raw`"'+1+1"`);
    expect(escapeCsvCell('-1+1')).toBe(String.raw`"'-1+1"`);
    expect(escapeCsvCell('@SUM(A1)')).toBe(String.raw`"'@SUM(A1)"`);
  });

  it('危险前缀的常见武器化载荷：DDE / HYPERLINK / cmd 拼接', () => {
    expect(escapeCsvCell("=cmd|' /C calc'!A0")).toBe(String.raw`"'=cmd|' /C calc'!A0"`);
    expect(escapeCsvCell('=HYPERLINK("http://evil.example","click")')).toBe(
      String.raw`"'=HYPERLINK(""http://evil.example"",""click"")"`,
    );
  });

  it('前导空白 + 制表符也按危险处理（不能靠空格绕过）', () => {
    expect(escapeCsvCell('  =1+1')).toBe(String.raw`"'  =1+1"`);
    expect(escapeCsvCell('\t=1+1')).toBe('"\'\t=1+1"');
  });

  it('非字符串值同样过防护（快照对象被序列化成以危险字符开头的文本时）', () => {
    // JSON.stringify({}) 以 `{` 开头 → 不触发；手工构造一个序列化后以 = 开头的场景不现实，
    // 这里锁定「数字负数」这一真实可发生的形态：仍按文本处理，不被 Excel 求值
    expect(escapeCsvCell(-42)).toBe(String.raw`"'-42"`);
  });
});

describe('escapeCsvCell · 不误伤普通内容', () => {
  it('普通文本 / 中文 / 数字 / 以字母开头的单元格原样输出', () => {
    expect(escapeCsvCell('示例企业')).toBe('"示例企业"');
    expect(escapeCsvCell('42')).toBe('"42"');
    expect(escapeCsvCell('a=1+1')).toBe('"a=1+1"');
    expect(escapeCsvCell('中间有 = 号的说明')).toBe('"中间有 = 号的说明"');
  });

  it('已经被单引号前缀过的值不重复加前缀（幂等：重复导出不会越加越多）', () => {
    expect(escapeCsvCell("'=1+1")).toBe(String.raw`"'=1+1"`);
  });
});

describe('escapeCsvCell · 形状约定', () => {
  it('null / undefined → 空单元格（不是字面量 ""）', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('引号翻倍、换行压成空格（不破坏行结构）', () => {
    expect(escapeCsvCell('含"引号"')).toBe('"含""引号"""');
    expect(escapeCsvCell('含\r\n换行')).toBe('"含 换行"');
  });

  it('对象值走 JSON 序列化后再编码', () => {
    expect(escapeCsvCell({ from: 'active' })).toBe(`"{""from"":""active""}"`);
  });
});

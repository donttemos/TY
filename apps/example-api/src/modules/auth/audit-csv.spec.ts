/*
 * @file 审计 CSV 导出列序与内容单测（PRD-015 FR-15-19）
 * @description 锁定四件事：
 *   ① M12 的 15 列位置与顺序不变，M15 的 8 个业务列**追加在末尾**（下游脚本与 mock 逐字节断言的前提）；
 *   ② 事件名与风险由注册表现算，未登记事件留空而不是猜测；
 *   ③ BOM / CRLF / 引号转义维持既有形态（Excel 打开不乱码）；
 *   ④ 公式注入危险前缀（= + - @ 制表符）在单元格编码阶段被中和——摘要 / 对象名称 / 操作人 /
 *      原因都是用户可控文本，引号转义挡不住 Excel 求值，UI 校验也挡不住导入与历史数据。
 * @author donttemo
 * @created 2026-10-20
 * @module example-api/auth
 */
import { describe, expect, it } from 'vitest';
import type { AuditLogRecord } from '@fw/auth';
import { buildAuditCsv } from './audit.controller.js';

/** 基线审计行（已登记事件 + 业务快照） */
function row(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: 'a-1',
    tenantId: '1',
    userId: 'u-1',
    module: 'saas',
    action: 'update',
    category: 'tenant',
    event: 'saas.lifecycle.freeze',
    result: 'success',
    familyId: null,
    jti: null,
    requestId: 'req-1',
    targetType: 'tenant',
    targetId: '1024',
    beforeValue: { from: 'active', to: 'frozen' },
    afterValue: { from: 'active', to: 'frozen' },
    ip: '10.0.0.1',
    userAgent: 'jest',
    traceId: 'trace-1',
    createdAt: new Date('2026-10-20T10:00:00.000Z'),
    summary: '将租户「示例企业」由正常变更为冻结（原因：欠费）',
    targetLabel: '示例企业',
    actorLabel: '平台管理员',
    reason: '欠费',
    auditSource: 'domain',
    ...overrides,
  };
}

/** 取 CSV 数据行（去掉 BOM 与表头，按 CRLF 切） */
function dataRowOf(csv: string): string {
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  return lines[1]!;
}

describe('buildAuditCsv · 列序（追加式）', () => {
  it('表头 = M12 十五列 + M15 八列追加在末尾', () => {
    const header = buildAuditCsv([]).replace(/^\uFEFF/, '').split('\r\n')[0]!;
    expect(header.split(',')).toEqual([
      'id', 'createdAt', 'userId', 'module', 'action', 'targetType', 'targetId', 'ip', 'traceId',
      'requestId', 'familyId', 'category', 'event', 'before', 'after',
      'eventName', 'summary', 'targetLabel', 'actorLabel', 'reason', 'result', 'auditSource', 'risk',
    ]);
  });

  it('BOM + CRLF 形态不变（Excel 打开中文不乱码）', () => {
    const csv = buildAuditCsv([]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('buildAuditCsv · 业务列内容', () => {
  it('已登记事件：事件名与风险由注册表补全，快照列原样输出', () => {
    // 用「行尾后缀」断言而不是按逗号切分：JSON 快照本身含逗号，切分不可靠
    const dataRow = dataRowOf(buildAuditCsv([row()]));
    expect(dataRow).toContain('"冻结租户","将租户「示例企业」由正常变更为冻结（原因：欠费）","示例企业","平台管理员","欠费","success","domain","high"');
  });

  it('未登记事件：事件名与风险留空（不猜测含义）', () => {
    const dataRow = dataRowOf(
      buildAuditCsv([
        row({ event: 'legacy.custom.event', summary: null, targetLabel: null, actorLabel: null, reason: null, auditSource: null }),
      ]),
    );
    // 空值单元格是空串（不是 ""），故尾部为五个空列 + success + 两个空列
    expect(dataRow.endsWith(',,,,,"success",,')).toBe(true);
  });

  it('引号与换行按既有规则转义（不破坏行结构）', () => {
    const dataRow = dataRowOf(buildAuditCsv([row({ summary: '含"引号"与\n换行' })]));
    expect(dataRow).toContain('"含""引号""与 换行"');
    // 换行被压成空格，仍是「表头 + 1 数据行」（尾部 CRLF 产生一个空段，已被过滤）
    expect(buildAuditCsv([row({ summary: '含\n换行' })]).split('\r\n').filter(Boolean)).toHaveLength(2);
  });
});

describe('buildAuditCsv · 公式注入防护（CSV Injection）', () => {
  it('摘要 / 对象名称 / 操作人 / 原因以 = + - @ 开头时被单引号中和', () => {
    const dataRow = dataRowOf(
      buildAuditCsv([
        row({
          event: 'legacy.custom.event',
          summary: "=cmd|' /C calc'!A0",
          targetLabel: '+1+1',
          actorLabel: '-1+1',
          reason: '@SUM(A1)',
          auditSource: null,
        }),
      ]),
    );
    // 引号转义不等于防护：不加前缀时 Excel 打开就会求值，这里逐列断言已被中和
    expect(dataRow).toContain(String.raw`"'=cmd|' /C calc'!A0"`);
    expect(dataRow).toContain('"\'+1+1"');
    expect(dataRow).toContain('"\'-1+1"');
    expect(dataRow).toContain('"\'@SUM(A1)"');
  });

  it('HYPERLINK 载荷：单引号前缀 + 引号翻倍，两个转义同时生效', () => {
    const dataRow = dataRowOf(buildAuditCsv([row({ summary: '=HYPERLINK("http://evil.example","click")' })]));
    expect(dataRow).toContain(String.raw`"'=HYPERLINK(""http://evil.example"",""click"")"`);
  });

  it('JSON 快照以 { 开头，内部出现 = 也不会被改写（防护只看单元格首字符）', () => {
    const dataRow = dataRowOf(buildAuditCsv([row({ beforeValue: { note: '=1+1' }, afterValue: { note: '+1+1' } })]));
    expect(dataRow).toContain('""note"":""=1+1""');
    expect(dataRow).toContain('""note"":""+1+1""');
  });

  it('普通中文 / 数字列不被防护误伤（导出值一个字都不变）', () => {
    const dataRow = dataRowOf(buildAuditCsv([row({ targetLabel: '示例企业（华东）', targetId: '1024' })]));
    expect(dataRow).toContain('"示例企业（华东）"');
    expect(dataRow).toContain('"1024"');
  });
});

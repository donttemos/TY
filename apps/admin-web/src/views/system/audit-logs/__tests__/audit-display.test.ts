/*
 * @file 审计运营视图展示映射单测（PRD-015 FR-15-14/15/17）
 * @description 锁定三级降级链与标签语义：
 *   摘要优先（row.summary）→ 事件名+对象 → 未登记原始码 → 上线前旧行的 module/action 中文；
 *   结果四态（success/denied/failed/unknown）与「未标注」必须可区分；风险缺失时显示空。
 *   操作人只认写入时固化的名称快照，缺失时显式标注「名称快照缺失」——不能用当前用户名回填
 *   （否则改名后的历史行会显示改名后的名字，等于把今天的事实写成昨天的）。
 *   这些是「不编造历史」的底线，回归时最先被破坏。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/views
 */
import { describe, expect, it } from 'vitest';
import type { AuditEventDefinition, AuditLogRecord } from '@/api/types';
import {
  actorText,
  auditTitle,
  isLegacyRow,
  resultMeta,
  riskMeta,
  sourceText,
  targetText,
} from '../audit-display';

/** 基线审计行（默认：有摘要、成功、domain 来源） */
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
    beforeValue: null,
    afterValue: null,
    ip: '10.0.0.1',
    userAgent: 'jest',
    traceId: 'trace-1',
    createdAt: '2026-10-20T10:00:00.000Z',
    summary: '将租户「示例企业」由正常变更为冻结（原因：欠费）',
    targetLabel: '示例企业',
    actorLabel: '平台管理员',
    reason: '欠费',
    auditSource: 'domain',
    ...overrides,
  };
}

const freezeEvent: AuditEventDefinition = {
  code: 'saas.lifecycle.freeze',
  name: '冻结租户',
  category: 'tenant',
  risk: 'high',
  reviewRequired: true,
};

describe('auditTitle · 三级降级链', () => {
  it('有业务摘要：直接使用（不重新渲染、不改写）', () => {
    expect(auditTitle(row(), freezeEvent)).toEqual({
      text: '将租户「示例企业」由正常变更为冻结（原因：欠费）',
      kind: 'summary',
    });
  });

  it('无摘要但有已登记事件：事件名 + 对象，不编造句子', () => {
    expect(auditTitle(row({ summary: null }), freezeEvent)).toEqual({ text: '冻结租户 · 示例企业', kind: 'event' });
    expect(auditTitle(row({ summary: null, targetLabel: null, targetId: '1024' }), freezeEvent).text).toBe('冻结租户 · 1024');
  });

  it('未登记事件：显示原始码并标注（不猜测含义）', () => {
    expect(auditTitle(row({ summary: null, event: 'legacy.custom.event' }), undefined)).toEqual({
      text: 'legacy.custom.event',
      kind: 'unregistered',
    });
  });

  it('上线前旧行：module/action 中文 + 未知模块回退原值', () => {
    expect(auditTitle(row({ summary: null, event: null, module: 'auth', action: 'update' }), undefined)).toEqual({
      text: '认证 · 更新',
      kind: 'legacy',
    });
    expect(auditTitle(row({ summary: null, event: null, module: 'mystery', action: 'weird' as unknown as AuditLogRecord['action'] }), undefined).text).toBe(
      'mystery · weird',
    );
  });
});

describe('结果 / 风险标签', () => {
  it('四态各有独立文案；null 是「未标注」而非「结果未知」', () => {
    expect(resultMeta('success')).toMatchObject({ label: '成功', tagType: 'success' });
    expect(resultMeta('denied')).toMatchObject({ label: '已拒绝', tagType: 'warning' });
    expect(resultMeta('failed')).toMatchObject({ label: '失败', tagType: 'danger' });
    expect(resultMeta('unknown')).toMatchObject({ label: '结果未知', tagType: 'info' });
    expect(resultMeta(null).label).toBe('未标注');
  });

  it('未知结果值原样展示（契约外数据不静默吞掉）', () => {
    expect(resultMeta('timeout').label).toBe('timeout');
  });

  it('风险来自注册表；未登记事件无风险判断', () => {
    expect(riskMeta(freezeEvent)).toMatchObject({ label: '高风险', tagType: 'warning' });
    expect(riskMeta({ ...freezeEvent, risk: 'critical' })).toMatchObject({ label: '紧急', tagType: 'danger' });
    expect(riskMeta(undefined)).toBeNull();
  });
});

describe('操作人 / 对象 / 来源', () => {
  it('操作人只认名称快照；缺失时显式标注 + ID，不回退当前用户名', () => {
    expect(actorText(row())).toBe('平台管理员');
    // 关键反向断言：早期实现返回 'u-1'（ID），页面再拿当前用户列表把 ID 翻译成「现在的名字」，
    // 于是「运营 A → 运营 B」改名后历史行显示「运营 B」。缺失必须说出来，不能翻译成今天的名字。
    expect(actorText(row({ actorLabel: null }))).toBe('名称快照缺失（ID: u-1）');
    expect(actorText(row({ actorLabel: null, userId: null }))).toBe('系统');
  });

  it('对象优先名称快照 → 类型:ID → —', () => {
    expect(targetText(row())).toBe('示例企业');
    expect(targetText(row({ targetLabel: null }))).toBe('tenant:1024');
    expect(targetText(row({ targetLabel: null, targetType: null }))).toBe('—');
  });

  it('记录来源可区分领域记录 / 接口兜底 / 未标注', () => {
    expect(sourceText(row())).toBe('业务记录');
    expect(sourceText(row({ auditSource: 'interceptor' }))).toBe('接口兜底');
    expect(sourceText(row({ auditSource: null }))).toBe('未标注');
  });

  it('旧行判定：既无摘要也无事件码（有事件码但缺摘要不算旧行）', () => {
    expect(isLegacyRow(row({ summary: null, event: null }))).toBe(true);
    expect(isLegacyRow(row({ summary: null }))).toBe(false);
    expect(isLegacyRow(row())).toBe(false);
  });
});

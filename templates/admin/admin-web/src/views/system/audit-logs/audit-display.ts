/*
 * @file 审计运营视图的展示映射（PRD-015 FR-15-14/15/17）
 * @description 纯函数：把审计行 + 事件定义翻译成运营可读的文本与标签。
 *   三条硬约束（与 ADR-0032 对应）：
 *   ① 摘要只认 `row.summary`（服务端写入时固化）；缺失时退化为「事件名称 · 对象」，
 *      **不重新渲染模板、不编造句子**——历史行不能凭空长出当时不存在的业务描述；
 *   ② 未登记事件码显示原始码并标注「未登记」，绝不猜测含义；
 *   ③ 结果/风险标签是展示语义，取值集合与后端契约一致（success/denied/failed/unknown）；
 *   ④ 操作人只认 `row.actorLabel`（写入时固化的名称快照）——缺失时标注「名称快照缺失」并附
 *      操作人 ID，**绝不用当前用户列表的名称回填**（那是把今天的事实写成昨天的）。
 * @author donttemo
 * @created 2026-10-20
 * @modified 2026-10-20 donttemo M15 安全加固：actorText 不再回退当前用户名，改为「名称快照缺失 + ID」
 * @module admin-web/views
 */

import type { AuditEventDefinition, AuditLogRecord } from '@/api/types';

/** 摘要来源（决定列表首列如何呈现与是否提示） */
export type AuditTitleKind = 'summary' | 'event' | 'unregistered' | 'legacy';

/** 列表首列结果 */
export interface AuditTitle {
  /** 主文本 */
  text: string;
  /** 来源类型（summary=业务摘要；event=事件名兜底；unregistered=未登记码；legacy=上线前旧行） */
  kind: AuditTitleKind;
}

/** 结果标签（tag type 与颜色语义：成功绿 / 拒绝橙 / 失败红 / 未知灰） */
export const RESULT_META: Record<string, { label: string; tagType: '' | 'success' | 'warning' | 'danger' | 'info' }> = {
  success: { label: '成功', tagType: 'success' },
  denied: { label: '已拒绝', tagType: 'warning' },
  failed: { label: '失败', tagType: 'danger' },
  unknown: { label: '结果未知', tagType: 'info' },
};

/** 风险标签（治理判断，由注册表定义，不落库） */
export const RISK_META: Record<string, { label: string; tagType: '' | 'success' | 'warning' | 'danger' | 'info' }> = {
  low: { label: '一般', tagType: 'info' },
  notice: { label: '注意', tagType: '' },
  high: { label: '高风险', tagType: 'warning' },
  critical: { label: '紧急', tagType: 'danger' },
};

/** 风险筛选项（顺序 = 严重度递增） */export const RISK_OPTIONS = [
  { label: '一般', value: 'low' },
  { label: '注意', value: 'notice' },
  { label: '高风险', value: 'high' },
  { label: '紧急', value: 'critical' },
];

/** 审计大类筛选项（沿用 M12 七值，低基数粗筛） */
export const CATEGORY_OPTIONS = [
  { label: '认证', value: 'auth' },
  { label: '安全', value: 'security' },
  { label: '管理', value: 'admin' },
  { label: '数据', value: 'data' },
  { label: '配置', value: 'config' },
  { label: '租户', value: 'tenant' },
  { label: '系统', value: 'system' },
];

/** 结果筛选项 */
export const RESULT_OPTIONS = [
  { label: '成功', value: 'success' },
  { label: '已拒绝', value: 'denied' },
  { label: '失败', value: 'failed' },
  { label: '结果未知', value: 'unknown' },
];

/**
 * 旧行的 module/action 中文名（仅用于「上线前记录」的降级展示）
 *
 * 正常路径不依赖本表：新记录有 `summary`，注册表事件有名称。
 * 这里的映射只为让历史行不至于显示 `auth / update` 这种纯技术串；
 * 缺项一律回退原值，不做猜测。
 */
const MODULE_LABELS: Record<string, string> = {
  auth: '认证',
  user: '用户',
  role: '角色',
  tenant: '租户',
  queue: '队列',
  config: '配置',
  saas: 'SaaS 运营',
  audit: '审计',
};

const ACTION_LABELS: Record<string, string> = {
  create: '新增',
  update: '更新',
  delete: '删除',
  login: '登录',
  logout: '登出',
  export: '导出',
  grant: '授权',
  security: '安全事件',
};

/**
 * 列表首列文本（三级降级链，见文件头）
 * @param row 审计行
 * @param definition 已登记的事件定义（未登记传 undefined）
 */
export function auditTitle(row: AuditLogRecord, definition?: AuditEventDefinition): AuditTitle {
  if (row.summary) return { text: row.summary, kind: 'summary' };
  if (definition) {
    const objectText = row.targetLabel ?? row.targetId ?? '';
    return { text: objectText ? `${definition.name} · ${objectText}` : definition.name, kind: 'event' };
  }
  if (row.event) return { text: row.event, kind: 'unregistered' };
  const moduleLabel = MODULE_LABELS[row.module] ?? row.module;
  const actionLabel = ACTION_LABELS[row.action] ?? row.action;
  return { text: `${moduleLabel} · ${actionLabel}`, kind: 'legacy' };
}

/**
 * 结果标签（null = 未标注，区别对待「结果未知」）
 * @param result 结果值
 */
export function resultMeta(result: string | null): { label: string; tagType: '' | 'success' | 'warning' | 'danger' | 'info' } {
  if (!result) return { label: '未标注', tagType: 'info' };
  return RESULT_META[result] ?? { label: result, tagType: 'info' };
}

/**
 * 风险标签（未登记事件无风险判断 → 显示 —）
 * @param definition 事件定义
 */
export function riskMeta(definition?: AuditEventDefinition): { label: string; tagType: '' | 'success' | 'warning' | 'danger' | 'info' } | null {
  if (!definition?.risk) return null;
  return RISK_META[definition.risk] ?? { label: definition.risk, tagType: 'info' };
}

/**
 * 名称快照缺失时的显式文案（PRD-015 FR-15-04 / AC-15-02）
 *
 * 历史行没有 `actorLabel` 只能说明「写入时没固化」，不能说明「操作人就是现在这个名字」。
 * 展示层据此如实标注，而不是拿当前用户列表的名称回填一个看起来完整的答案。
 */
export const ACTOR_SNAPSHOT_MISSING = '名称快照缺失';

/**
 * 操作人文本：名称快照优先；无快照时显式标注「名称快照缺失」，**不回退到当前用户列表**
 *
 * 回退当前名称是把今天的事实写成昨天的：管理员当时叫「运营 A」、之后改名「运营 B」，
 * 历史行不能因此显示「运营 B」。缺失是可核验的事实（附 ID 便于追查），不是需要美化的空白。
 * @param row 审计行
 */
export function actorText(row: AuditLogRecord): string {
  if (row.actorLabel) return row.actorLabel;
  if (row.userId) return `${ACTOR_SNAPSHOT_MISSING}（ID: ${row.userId}）`;
  return '系统';
}

/**
 * 目标对象文本：名称快照 → 类型:ID → —
 * @param row 审计行
 */
export function targetText(row: AuditLogRecord): string {
  if (row.targetLabel) return row.targetLabel;
  if (row.targetType) return row.targetId ? `${row.targetType}:${row.targetId}` : row.targetType;
  return '—';
}

/**
 * 记录来源文本（domain / interceptor / 未标注）
 * @param row 审计行
 */
export function sourceText(row: AuditLogRecord): string {
  if (row.auditSource === 'domain') return '业务记录';
  if (row.auditSource === 'interceptor') return '接口兜底';
  return '未标注';
}

/**
 * 是否为「业务摘要上线前」的历史记录（用于详情页提示）
 * @param row 审计行
 */
export function isLegacyRow(row: AuditLogRecord): boolean {
  return !row.summary && !row.event;
}

/**
 * 变更字段的中文名映射（供 DiffViewer 的 fieldMeta）
 * @param definition 事件定义
 */
export function changeFieldMeta(
  definition?: AuditEventDefinition,
): Record<string, { label: string; valueLabels?: Record<string, string> }> | undefined {
  return definition?.changeFields;
}

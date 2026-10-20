/*
 * @file 审计日志服务与脱敏
 * @description PRD-003 FR-08 / NFR：记录操作人、时间、IP、模块、动作、变更前后值（敏感字段脱敏）。
 *   落盘为「异步 + 本地兜底」：writeAuditLog 失败只告警不抛错，绝不阻塞业务主流程；
 *   日志与审计统一取 @fw/logger 的 traceId，便于与结构化日志串联排障。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-06，ADR-0025）：统一审计事件契约——
 *   AuditEntry / AuditLogRecord 全量落位 category/event/result/familyId/jti/requestId（缺省 null），
 *   persist 统一填充，杜绝「部分调用方带事件字段、部分不带」的形状漂移
 * @modified 2026-10-20 donttemo M15 安全加固（FR-15-04）：persist 在写入时刻集中补 `actorLabel`
 *   快照（调用方未显式提供时按 userId 回查昵称/账号名）。此前用户 / 角色 / 配置等写入点漏传该字段，
 *   页面回退到「当前用户列表」的名称 → 改名后历史记录显示改名后的名字，历史身份失真
 * @module @fw/auth
 */

import { Logger, getRequestContext, getTraceId } from '@fw/logger';
import { BizError, ErrorCode } from '@fw/core';
import type { AuthStore } from './auth-store.js';
import { MASKED, SENSITIVE_FIELDS } from './constants.js';
import { auditEventDomain, findAuditEvent, renderAuditSummary, type AuditEventDefinition } from './audit-events.js';
import type {
  AuditAction,
  AuditCategory,
  AuditEventResult,
  AuditLogRecord,
  AuditQuery,
  AuditSource,
  ID,
} from './types.js';
import type { PageResult } from '@fw/db';

const logger = Logger.for('auth.audit');

/** 脱敏递归深度上限（防深层对象膨胀） */
const MAX_DEPTH = 6;

/** 快照列长度上限（与数据字典 §3.13 对齐；超限截断并以省略号标记，不静默丢内容） */
const MAX_SUMMARY_LENGTH = 255;
const MAX_TARGET_LABEL_LENGTH = 128;
const MAX_ACTOR_LABEL_LENGTH = 64;
const MAX_REASON_LENGTH = 255;

/** 敏感字段名集合（大小写不敏感匹配） */
const SENSITIVE = new Set<string>(SENSITIVE_FIELDS.map((f) => f.toLowerCase()));

/**
 * 操作人名称回查所需的最小存储端口（`AuthStore` 的子集，成员可选）
 *
 * 声明成可选是为了让「只实现了 writeAuditLog 的只读测试桩」也能工作：缺方法时按
 * 「无法确定操作人名称」处理，而不是让审计写入因为一个可选增强字段而失败。
 */
interface ActorLabelLookupPort {
  findUserById?: (id: ID) => Promise<{ nickname: string | null; username: string } | null>;
}

/** 审计记录入参 */
export interface AuditEntry {
  /** 操作人；缺省时自动取请求上下文 userId */
  userId?: ID | null;
  /** 模块名 */
  module: string;
  /** 动作 */
  action: AuditAction;
  /** 审计大类（PRD-012 OBS-06）；缺省为 null（旧调用方零改动） */
  category?: AuditCategory | null;
  /** 点分事件名（PRD-012 OBS-06，如 refresh.replay_detected）；缺省为 null */
  event?: string | null;
  /** 事件结果（PRD-012 OBS-06）；缺省为 null */
  result?: AuditEventResult | null;
  /** 令牌家族 ID（安全事件关联键）；缺省为 null */
  familyId?: string | null;
  /** 令牌标识 jti（非令牌本体）；缺省为 null */
  jti?: string | null;
  /** 单次请求 ID（PRD-012 OBS-09，W2 起填充）；缺省为 null */
  requestId?: string | null;
  /** 对象类型 */
  targetType?: string | null;
  /** 对象 ID */
  targetId?: string | null;
  /** 变更前（未脱敏，落盘前统一处理） */
  before?: unknown;
  /** 变更后 */
  after?: unknown;
  /** 来源 IP；缺省由调用方（拦截器）注入 */
  ip?: string | null;
  /** 客户端标识 */
  userAgent?: string | null;
  /** 所属租户；缺省取请求上下文（PRD-015 FR-15-06） */
  tenantId?: string | null;
  /** 业务摘要快照（PRD-015 FR-15-04） */
  summary?: string | null;
  /** 目标对象名称快照 */
  targetLabel?: string | null;
  /** 操作人名称快照 */
  actorLabel?: string | null;
  /** 操作原因 */
  reason?: string | null;
  /** 记录来源（domain / interceptor，PRD-015 FR-15-05） */
  auditSource?: AuditSource | null;
}

/**
 * 事件写入入参（PRD-015 FR-15-03）
 *
 * 与 `AuditEntry` 的区别：调用方只描述**业务事实**，不再手传 module/action/category——
 * 这三项由注册表定义补齐，避免同义字段在多处漂移。
 */
export interface AuditEventPayload {
  userId?: ID | null;
  targetType?: string | null;
  targetId?: string | null;
  /** 目标对象名称快照（租户名/套餐名/用户名）；缺省回退 targetId */
  targetLabel?: string | null;
  /** 操作人名称快照 */
  actorLabel?: string | null;
  /** 操作原因（人工填写或系统生成） */
  reason?: string | null;
  /** 显式摘要（优先于注册表模板，ADR-0032 R3 第一优先级） */
  summary?: string | null;
  /** 结果；缺省 success（denied / failed / unknown 必须显式声明） */
  result?: AuditEventResult;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  familyId?: string | null;
  jti?: string | null;
  requestId?: string | null;
  tenantId?: string | null;
}

/** 文本列裁剪：超长截断并以省略号标记（不静默丢字段，落库值仍可读） */
function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text.length === 0) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 从 `after` 快照提取摘要模板变量
 *
 * 只取注册表 `changeFields` 声明的字段（白名单）：模板不得把未声明的、可能敏感的值带进摘要。
 * 枚举值按 `valueLabels` 翻译为业务文案（如 3 → 冻结），保证摘要可读。
 */
function buildSummaryVars(
  definition: AuditEventDefinition,
  payload: AuditEventPayload,
  after: unknown,
): Record<string, string> {
  const vars: Record<string, string> = {
    targetLabel: payload.targetLabel ?? payload.targetId ?? '',
    reason: payload.reason ?? '',
  };
  const source = after && typeof after === 'object' ? (after as Record<string, unknown>) : {};
  for (const [field, meta] of Object.entries(definition.changeFields ?? {})) {
    const raw = source[field];
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'object') continue;
    const key = String(raw);
    vars[field] = meta.valueLabels?.[key] ?? key;
  }
  return vars;
}

/**
 * 审计数据脱敏：按字段名遮蔽敏感值，Date → ISO 串，保证可 JSON 序列化
 * @param value 任意待落盘值
 * @param depth 当前递归深度（内部使用）
 * @returns 脱敏后的可序列化值
 */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[too-deep]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitizeForAudit(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE.has(key.toLowerCase()) ? MASKED : sanitizeForAudit(val, depth + 1);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  return value;
}

/**
 * 审计日志服务
 */
export class AuditService {
  /** 未登记事件码是否 fail-fast（默认非生产开启；生产只告警不阻塞业务，ADR-0032 R1） */
  private readonly strictEvents: boolean;

  /**
   * @param store 鉴权存储（审计表读写）
   * @param options.strictEvents 覆盖默认严格模式（测试可显式关闭以验证生产降级路径）
   */
  constructor(
    private readonly store: AuthStore,
    options: { strictEvents?: boolean } = {},
  ) {
    this.strictEvents = options.strictEvents ?? process.env.NODE_ENV !== 'production';
  }

  /**
   * 异步记录一条审计日志（不阻塞、不抛错）
   * @param entry 审计内容
   */
  record(entry: AuditEntry): void {
    void this.persist(entry).catch((error: unknown) => {
      // 本地兜底：落盘失败时把关键字段写进结构化日志，至少可人工追溯
      logger.error('审计日志落盘失败，已降级为日志兜底', {
        module: entry.module,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        userId: entry.userId ?? getRequestContext()?.userId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * 同步等待落盘（用于测试与强一致场景）
   * @param entry 审计内容
   */
  async recordSync(entry: AuditEntry): Promise<void> {
    await this.persist(entry);
  }

  /**
   * 按事件码记录一条业务事件（PRD-015 FR-15-03，ADR-0032 R1/R3/R5）
   *
   * 与 `record()` 的分工：本方法面向**业务事实**，module/action/category/targetType 与摘要
   * 由注册表补全，调用方只传对象、原因与前后值；`record()` 保留为低层通道（拦截器、桥接）。
   *
   * 未知事件码：严格模式（默认测试/开发）同步抛 400，让拼写错误在开发期暴露；
   * 生产降级为「原样落库 + error 日志」——审计不得阻塞主流程，也不能让事件凭空消失。
   * @param code 事件码（必须已在 AUDIT_EVENTS 注册）
   * @param payload 业务事实
   */
  recordEvent(code: string, payload: AuditEventPayload = {}): void {
    const entry = this.buildEventEntry(code, payload);
    void this.persist(entry).catch((error: unknown) => {
      logger.error('审计事件落盘失败，已降级为日志兜底', {
        event: code,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        userId: entry.userId ?? getRequestContext()?.userId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * 同步版本（强一致场景 / 测试）
   * @param code 事件码
   * @param payload 业务事实
   */
  async recordEventSync(code: string, payload: AuditEventPayload = {}): Promise<void> {
    await this.persist(this.buildEventEntry(code, payload));
  }

  /**
   * 组装事件审计行：注册表补全 + 摘要三级生成链 + 来源标记
   * @param code 事件码
   * @param payload 业务事实
   * @returns 待落盘条目
   */
  private buildEventEntry(code: string, payload: AuditEventPayload): AuditEntry {
    const definition = findAuditEvent(code);
    if (!definition) {
      const message = `未登记的审计事件码：${code}（请先在 @fw/auth 的 AUDIT_EVENTS 注册）`;
      if (this.strictEvents) throw new BizError(ErrorCode.BAD_REQUEST, message);
      logger.error('未登记的审计事件码，按原样落库', { code });
      return {
        userId: payload.userId,
        module: auditEventDomain(code),
        action: 'update',
        category: null,
        event: code,
        result: payload.result ?? 'success',
        targetType: payload.targetType ?? null,
        targetId: payload.targetId ?? null,
        before: payload.before,
        after: payload.after,
        ip: payload.ip,
        userAgent: payload.userAgent,
        tenantId: payload.tenantId,
        summary: clip(payload.summary, MAX_SUMMARY_LENGTH),
        targetLabel: clip(payload.targetLabel, MAX_TARGET_LABEL_LENGTH),
        actorLabel: clip(payload.actorLabel, MAX_ACTOR_LABEL_LENGTH),
        reason: clip(payload.reason, MAX_REASON_LENGTH),
        auditSource: 'domain',
        familyId: payload.familyId,
        jti: payload.jti,
        requestId: payload.requestId,
      };
    }

    // 摘要优先级：调用点显式 → 注册表模板 → 回退「事件名：对象」（ADR-0032 R3）
    const summary = clip(
      payload.summary ?? renderAuditSummary(definition, buildSummaryVars(definition, payload, payload.after)),
      MAX_SUMMARY_LENGTH,
    );

    return {
      userId: payload.userId,
      module: definition.module,
      action: definition.action,
      category: definition.category,
      event: definition.code,
      result: payload.result ?? 'success',
      targetType: payload.targetType ?? definition.targetType ?? null,
      targetId: payload.targetId ?? null,
      before: payload.before,
      after: payload.after,
      ip: payload.ip,
      userAgent: payload.userAgent,
      tenantId: payload.tenantId,
      summary,
      targetLabel: clip(payload.targetLabel, MAX_TARGET_LABEL_LENGTH),
      actorLabel: clip(payload.actorLabel, MAX_ACTOR_LABEL_LENGTH),
      reason: clip(payload.reason, MAX_REASON_LENGTH),
      auditSource: 'domain',
      familyId: payload.familyId,
      jti: payload.jti,
      requestId: payload.requestId,
    };
  }

  /**
   * 审计日志分页查询（按人 / 对象 / 时间）
   * @param query 查询条件
   */
  async page(query: AuditQuery): Promise<PageResult<AuditLogRecord>> {
    return this.store.pageAuditLogs(query);
  }

  /** 组装并写入记录（统一事件契约字段全量落位，缺省为 null——OBS-08「字段完整」） */
  private async persist(entry: AuditEntry): Promise<void> {
    const userId = entry.userId ?? getRequestContext()?.userId ?? null;
    // PRD-015 FR-15-04：操作人名称快照——调用方没显式给，就在「写入时刻」回查并固化。
    // 之后改名不回头改历史行；展示侧也不允许用当前用户列表回填（ADR-0032 R2 事实与字典分离）。
    const actorLabel =
      clip(entry.actorLabel, MAX_ACTOR_LABEL_LENGTH) ?? clip(await this.lookupActorLabel(userId), MAX_ACTOR_LABEL_LENGTH);
    await this.store.writeAuditLog({
      userId,
      module: entry.module,
      action: entry.action,
      category: entry.category ?? null,
      event: entry.event ?? null,
      result: entry.result ?? null,
      familyId: entry.familyId ?? null,
      jti: entry.jti ?? null,
      requestId: entry.requestId ?? getRequestContext()?.requestId ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      beforeValue: entry.before === undefined ? null : sanitizeForAudit(entry.before),
      afterValue: entry.after === undefined ? null : sanitizeForAudit(entry.after),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      // PRD-015 FR-15-06：租户维度此前恒 0（列为默认值），现由请求上下文补齐；
      // 缺失时留 undefined 交由存储层归一为 0（未知/存量），读取侧恒为字符串
      tenantId: entry.tenantId ?? getRequestContext()?.tenantId ?? undefined,
      // PRD-015 FR-15-04：业务快照（缺省 null，不做任何推断性填充）
      summary: clip(entry.summary, MAX_SUMMARY_LENGTH),
      targetLabel: clip(entry.targetLabel, MAX_TARGET_LABEL_LENGTH),
      actorLabel,
      reason: clip(entry.reason, MAX_REASON_LENGTH),
      auditSource: entry.auditSource ?? null,
      traceId: getTraceId() || null,
      createdAt: new Date(),
    });
  }

  /**
   * 写入时刻回查操作人名称（快照来源：昵称优先，账号名兜底）
   *
   * 为什么在服务端集中补而不是要求每个调用点传：`recordEvent` 有十余个写入点
   * （用户 / 角色 / 配置 / 租户 / 导出 / 阻断器兜底），漏传一处就会让那条历史失去身份。
   * 集中补全把「有没有快照」从调用纪律变成结构保证；调用点显式传值时仍以显式值为准
   * （业务更清楚当时该显示谁，例如代操作场景）。
   *
   * 回查失败（用户已删除 / 存储异常 / 只读测试桩）一律返回 null：审计行保留「快照缺失」，
   * 绝不用后来者的名称冒充当时的人。
   * @param userId 操作人 ID（缺省表示系统行为）
   * @returns 名称快照；无法确定时为 null
   */
  private async lookupActorLabel(userId: ID | null): Promise<string | null> {
    if (!userId) return null;
    try {
      // 可选调用（?.）：单测里的只读桩可能没实现该端口，缺方法时按「无法确定」处理，不抛错
      const user = await (this.store as unknown as ActorLabelLookupPort).findUserById?.(userId);
      return user?.nickname ?? user?.username ?? null;
    } catch {
      return null;
    }
  }
}

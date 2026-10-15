/*
 * @file 配置中心审计桥（ConfigAuditPort → @fw/auth AuditService）
 * @description 端口反转（先例 DataScopeOrgPort）：@fw/config-center 不反向依赖鉴权包，
 *   由应用侧把配置变更桥接进统一审计（module=config，targetType=config，targetId=键名）。
 *   recordSync 同步等待落盘：审计失败抛错 → 管道整体失败回滚（先审计后生效，PRD-009 FR-05）。
 *   traceId 由 AuditService.persist 自动取请求上下文（api 源带、file 源为空）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/config-center
 */
import type { AuditService } from '@fw/auth';
import type { ConfigAuditPort, ConfigChangeRecord } from '@fw/config-center';

/**
 * 审计桥实现
 */
export class ConfigAuditBridge implements ConfigAuditPort {
  /**
   * @param audit 应用统一审计服务（全局模块提供）
   */
  constructor(private readonly audit: AuditService) {}

  /** @inheritdoc */
  async recordChange(change: ConfigChangeRecord): Promise<void> {
    await this.audit.recordSync({
      userId: change.operatorId ?? null,
      module: 'config',
      action: 'update',
      targetType: 'config',
      targetId: change.key,
      before: { value: change.oldValue },
      after: {
        value: change.newValue,
        source: change.source,
        operator: change.operator,
        operatorId: change.operatorId ?? null,
        ok: change.ok,
        ...(change.reason ? { reason: change.reason } : {}),
      },
      // file 轮询入口无请求上下文：IP 留空（审计表可空列）
      ip: null,
      userAgent: null,
    });
  }
}

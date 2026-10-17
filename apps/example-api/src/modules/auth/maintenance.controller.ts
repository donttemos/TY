/*
 * @file 鉴权维护查询端点
 * @description GET /api/v1/auth-maintenance/{refresh-cleanup,audit-archive,key-ring} —— 三条运维快照端点。
 *   M12 W3（PRD-012 OBS-15，ADR-0027）：由类级 @Public 裸奔收敛为 **ops:read 权限守卫**（默认受保护，
 *   公开需显式白名单 + 理由 + 契约测试）；三个端点统一 `Cache-Control: no-store`（此前仅 key-ring 有）。
 *   零敏感契约不变：快照只含任务元数据与计数（auth-maintenance.contract.spec.ts 锁定）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo E-10：新增审计归档任务快照端点
 * @modified 2026-10-17 donttemo M12 W3（PRD-012 OBS-15/18）：@Public → ops:read 守卫 + 全端点 no-store + 快照公共字段集统一
 * @module example-api/auth
 */

import { Controller, Get, Header, Inject } from '@nestjs/common';
import { PERM, Permissions, TokenService, KeySource } from '@fw/auth';
import type { AuthStore } from '@fw/auth';
import { AUTH_STORE } from '@fw/auth';
import { AuthMaintenanceJobs, type RefreshCleanupSnapshot } from './auth-maintenance.js';
import { AuditArchiveJobs, type AuditArchiveSnapshot } from './audit-archive.jobs.js';

/** Key Ring 可观测快照（ADR-0024：零敏感材料——只有 keyId/kid/来源/计数） */
export interface KeyRingSnapshot {
  jwt: { currentKid: string; previousKid: string | null; source: KeySource };
  replacement: {
    mode: 'explicit' | 'legacy-hkdf';
    currentKeyId: string;
    keys: Array<{
      keyId: string;
      activeReplacementCipherCount: number;
      retirable: boolean;
      source: KeySource;
    }>;
  };
}

/**
 * 鉴权维护控制器：路径前缀 /api/v1/auth-maintenance
 * 守卫：需 ops:read（PERM.OPS_READ）；未登录 3001 / 无权限 3002（反向验证见契约测试元数据断言）。
 */
@Permissions(PERM.OPS_READ)
@Controller('/api/v1/auth-maintenance')
export class MaintenanceController {
  constructor(
    private readonly jobs: AuthMaintenanceJobs,
    private readonly archiveJobs: AuditArchiveJobs,
    private readonly tokens: TokenService,
    @Inject(AUTH_STORE) private readonly store: AuthStore,
  ) {}

  /** refresh 过期清理任务快照 */
  @Get('refresh-cleanup')
  @Header('Cache-Control', 'no-store')
  refreshCleanup(): RefreshCleanupSnapshot {
    return this.jobs.snapshot();
  }

  /** 审计归档任务快照（M10 E-10） */
  @Get('audit-archive')
  @Header('Cache-Control', 'no-store')
  auditArchive(): AuditArchiveSnapshot {
    return this.archiveJobs.snapshot();
  }

  /**
   * Key Ring 可观测快照（ADR-0024）：JWT Ring 稳定 kid + Replacement Ring 各 keyId 的
   * 「仍存在可恢复密文」计数与退役判据。安全边界（冻结）：不返回 secret/secret hash/
   * cipher/token/原始配置值——仅非敏感运维元数据；no-store 防止中间层缓存运维元数据。
   */
  @Get('key-ring')
  @Header('Cache-Control', 'no-store')
  async keyRing(): Promise<KeyRingSnapshot> {
    const info = this.tokens.getKeyRingInfo();
    const counts = await this.store.countReplacementCiphersByKeyId(new Date());
    const keyIds = [...new Set([...info.replacement.keyIds, ...Object.keys(counts)])].sort();
    const keys = keyIds.map((keyId) => {
      const active = counts[keyId] ?? 0;
      return {
        keyId,
        activeReplacementCipherCount: active,
        retirable: active === 0,
        source: (info.replacement.mode === 'explicit'
          ? 'explicit'
          : 'legacy-hkdf') as KeySource,
      };
    });
    return {
      jwt: {
        currentKid: info.jwt.currentKid,
        previousKid: info.jwt.previousKid,
        source: (info.jwt.hasPrevious ? 'jwt-secret-prev' : 'jwt-secret') as KeySource,
      },
      replacement: {
        mode: info.replacement.mode,
        currentKeyId: info.replacement.currentKeyId,
        keys,
      },
    };
  }
}

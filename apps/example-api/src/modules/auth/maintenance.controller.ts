/*
 * @file 鉴权维护查询端点
 * @description GET /api/v1/auth-maintenance/refresh-cleanup —— 暴露 refresh 过期记录清理任务
 *   （auth.refresh-cleanup，M3 遗留项④）的注册信息与最近一次运行快照；
 *   GET /api/v1/auth-maintenance/audit-archive —— 暴露审计归档任务（audit.archive，M10 E-10）
 *   的配置与最近一次运行快照（保留线 / 迁移条数 / 在线与归档表行数）。框架自检路由，标 @Public()。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo E-10：新增审计归档任务快照端点
 * @module example-api/auth
 */

import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Public, TokenService, KeySource } from '@fw/auth';
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
 */
@Public()
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
  refreshCleanup(): RefreshCleanupSnapshot {
    return this.jobs.snapshot();
  }

  /** 审计归档任务快照（M10 E-10） */
  @Get('audit-archive')
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

/*
 * @file 租户服务：候选编码 → 有效租户（fail-closed）
 * @description PRD-008 FR-01/FR-03：解析出的编码必须查库验证（存在、启用、未过期），
 *   任一条件不满足或未解析出候选值均抛 4001（fail-closed），绝不回退到「无租户」全量数据视图。
 *   租户信息按 TTL 内存缓存（TENANT_CACHE_TTL），停用/换库等管理操作最多延迟一个 TTL 生效。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo M9/PRD-009 FR-09：新增 updateRuntimeOptions——tenant.cacheTtl 经配置中心订阅热更（对新缓存条目生效）
 * @module @fw/tenant
 */
import { BizError, ErrorCode } from '@fw/core';
import { resolveTenantCode } from './resolver.js';
import type { TenantInfo, TenantResolutionInput, TenantResolutionOptions, TenantStorePort } from './types.js';

interface CacheEntry {
  tenant: TenantInfo | null;
  expiresAt: number;
}

/** 租户服务选项 */
export interface TenantServiceOptions {
  /** 解析配置（顺序与开关） */
  resolution: TenantResolutionOptions;
  /** 是否启用多租户（TENANT_ENABLED=false 时 resolve 直接短路为单租户模式） */
  enabled: boolean;
  /** 租户信息缓存 TTL（毫秒） */
  cacheTtlMs: number;
  /** 时钟注入（测试用） */
  now?: () => number;
}

/**
 * 租户服务：解析 + 校验 + 缓存
 */
export class TenantService {
  private readonly cache = new Map<string, CacheEntry>();

  private readonly now: () => number;

  constructor(
    private readonly store: TenantStorePort,
    private readonly options: TenantServiceOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** 是否启用多租户 */
  get enabled(): boolean {
    return this.options.enabled;
  }

  /**
   * 解析并验证租户。
   * - 未启用多租户：返回 null（单租户模式，调用方按无租户上下文处理）。
   * - 启用但未解析出候选 / 租户不存在 / 停用 / 已过期：抛 4001（fail-closed）。
   */
  async resolve(input: TenantResolutionInput): Promise<TenantInfo | null> {
    if (!this.options.enabled) return null;
    const code = resolveTenantCode(input, this.options.resolution);
    if (!code) {
      throw new BizError(ErrorCode.TENANT_INVALID, '缺失租户标识（子域名/请求头/令牌均未提供有效租户）');
    }
    return this.verify(code);
  }

  /** 按编码查租户（带 TTL 缓存）；不存在/停用/过期统一抛 4001 */
  async verify(code: string): Promise<TenantInfo> {
    const cached = this.cache.get(code);
    if (cached && cached.expiresAt > this.now()) {
      if (!cached.tenant) throw new BizError(ErrorCode.TENANT_INVALID, `租户不存在：${code}`);
      this.assertUsable(cached.tenant);
      return cached.tenant;
    }
    const tenant = await this.store.findTenantByCode(code);
    this.cache.set(code, { tenant, expiresAt: this.now() + this.options.cacheTtlMs });
    if (!tenant) throw new BizError(ErrorCode.TENANT_INVALID, `租户不存在：${code}`);
    this.assertUsable(tenant);
    return tenant;
  }

  /** 清空缓存（管理操作后主动失效） */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * 运行时更新租户信息缓存 TTL（M9/PRD-009 FR-09：由配置中心 onChange 订阅调用，禁止业务侧自行轮询）。
   * TTL 在每次写入缓存条目时读取，热更对新条目即时生效（已有条目按原到期时间过期）。
   * @param patch 待更新字段（缓存 TTL，毫秒）
   */
  updateRuntimeOptions(patch: { cacheTtlMs?: number }): void {
    if (patch.cacheTtlMs !== undefined) {
      this.options.cacheTtlMs = patch.cacheTtlMs;
    }
  }

  private assertUsable(tenant: TenantInfo): void {
    if (tenant.status !== 1) {
      throw new BizError(ErrorCode.TENANT_INVALID, `租户已停用：${tenant.code}`);
    }
    if (tenant.expireAt && new Date(tenant.expireAt).getTime() <= this.now()) {
      throw new BizError(ErrorCode.TENANT_INVALID, `租户已过期：${tenant.code}`);
    }
    if (tenant.isolation === 'dedicated' && !tenant.dbUrl) {
      throw new BizError(ErrorCode.TENANT_INVALID, `独立库租户缺少数据源配置：${tenant.code}`);
    }
  }
}

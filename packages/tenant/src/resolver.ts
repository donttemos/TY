/*
 * @file 租户编码解析（纯函数，三级回退）
 * @description PRD-008 FR-01：按可配顺序依次尝试「子域名 → 请求头 → JWT claim」，
 *   返回第一个命中的租户编码候选值。本函数只做「定位」，不查库、不判定租户有效性——
 *   有效性（存在 / 启用 / 未过期）由 TenantService 统一 fail-closed 判定。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-02）：裸抛迁移至 BizError 统一码（ADR-0025 三类治理）
 * @module @fw/tenant
 */
import { TENANT_CODE_PATTERN, type TenantResolutionInput, type TenantResolutionOptions, type TenantSource } from './types.js';
import { BizError, ErrorCode } from '@fw/core';

/** 从 Host 请求头剥离端口 */
function stripPort(host: string): string {
  const at = host.lastIndexOf(':');
  // IPv6 裸地址（含多个冒号）不处理端口剥离，直接返回小写主机名
  if (at > 0 && host.indexOf(':') === at) return host.slice(0, at).toLowerCase();
  return host.toLowerCase();
}

/** 子域名提取：host 必须以 `.baseDomain` 结尾，前缀即候选编码 */
function extractSubdomain(host: string | undefined, baseDomain: string | undefined): string | undefined {
  if (!host || !baseDomain) return undefined;
  const hostname = stripPort(host);
  const base = baseDomain.toLowerCase();
  if (hostname === base || !hostname.endsWith(`.${base}`)) return undefined;
  const prefix = hostname.slice(0, hostname.length - base.length - 1);
  // 多级子域名取最左段（如 a.b.example.com → a）；业务如需多级归属可在租户编码中约定
  const label = prefix.split('.')[0];
  return label || undefined;
}

/** 请求头提取：取第一个值并归一化 */
function extractHeader(input: TenantResolutionInput, headerName: string): string | undefined {
  const raw = input.headers[headerName];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

/** 解析顺序白名单校验 */
export function parseTenantOrder(raw: string): TenantSource[] {
  const allowed: readonly TenantSource[] = ['subdomain', 'header', 'jwt'];
  const list = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `TENANT_ORDER 非法：${raw}（至少需要一个来源）`);
  for (const item of list) {
    if (!allowed.includes(item as TenantSource)) {
      throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `TENANT_ORDER 非法：${item}（可选值 subdomain/header/jwt，逗号分隔）`);
    }
  }
  return list as TenantSource[];
}

/**
 * 三级回退解析：返回第一个格式合法的租户编码候选值；全部未命中返回 undefined。
 * 候选值不保证真实存在——存在性由 TenantService 查库判定。
 */
export function resolveTenantCode(input: TenantResolutionInput, options: TenantResolutionOptions): string | undefined {
  for (const source of options.order) {
    let candidate: string | undefined;
    if (source === 'subdomain') {
      candidate = extractSubdomain(input.host, options.baseDomain);
    } else if (source === 'header') {
      candidate = extractHeader(input, options.headerName.toLowerCase());
    } else {
      candidate = input.extractJwtClaim?.(options.jwtClaim);
    }
    if (candidate) {
      const normalized = candidate.toLowerCase();
      if (TENANT_CODE_PATTERN.test(normalized)) return normalized;
    }
  }
  return undefined;
}

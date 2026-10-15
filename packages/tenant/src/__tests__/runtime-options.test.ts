/*
 * @file 运行时选项热更测试（M9/PRD-009 FR-09）
 * @description 验证 tenant.cacheTtl 热更的生效路径：updateRuntimeOptions 就地改 TTL，
 *   新写入的缓存条目按新 TTL 过期（注入时钟精确推进，无真实等待）。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/tenant
 */
import { describe, expect, it } from 'vitest';
import { TenantService } from '../tenant.service.js';
import { DEFAULT_OPTIONS } from '../resolver.js';
import type { TenantStorePort, TenantInfo } from '../types.js';

/** 固定租户 */
function tenant(code: string): TenantInfo {
  return { id: '1', code, name: code, status: 1, isolation: 'shared' } as TenantInfo;
}

/** 计数存储桩 */
function store(rows: Record<string, TenantInfo | null>): TenantStorePort & { calls: number } {
  return {
    calls: 0,
    async findTenantByCode(code: string) {
      this.calls += 1;
      return rows[code] ?? null;
    },
  };
}

describe('TenantService · updateRuntimeOptions（配置中心热更生效路径）', () => {
  it('热更 cacheTtl 后，新缓存条目按新 TTL 过期（旧条目仍按原到期时间）', async () => {
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const storeSpy = store({ acme: tenant('acme') });
    const service = new TenantService(storeSpy, { resolution: DEFAULT_OPTIONS, enabled: true, cacheTtlMs: 10_000, now });

    // 首次解析：回源并写缓存（到期 = now + 10s）
    await service.verify('acme');
    expect(storeSpy.calls).toBe(1);

    // 热更 TTL → 2s；推进 5s：旧条目（10s 到期）仍命中
    service.updateRuntimeOptions({ cacheTtlMs: 2_000 });
    nowMs += 5_000;
    await service.verify('acme');
    expect(storeSpy.calls).toBe(1);

    // 失效后再解析：新条目按新 TTL（2s）写入；推进 3s 即过期回源
    service.invalidate();
    await service.verify('acme');
    expect(storeSpy.calls).toBe(2);
    nowMs += 3_000;
    await service.verify('acme');
    expect(storeSpy.calls).toBe(3);
  });
});

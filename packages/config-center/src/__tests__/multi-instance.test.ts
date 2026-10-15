/*
 * @file 配置中心多实例语义测试（M10 E-02）
 * @description 注入 ConfigHistoryPort（内存持久实现）后的跨实例一致性：两个共享同一持久历史
 *   与事实源的 ConfigCenterService 实例（= 两个进程/副本）——A 写入的版本 B 读取一致（AC2 前半）、
 *   B 回滚候选含 A 写入的版本且回滚结果一致（AC2 后半）、版本号以持久层为基线不撞号。
 *   反向验证：不注入 history 时行为与 M9 原语义一致（本地计数、本地回滚候选）。
 * @author donttemo
 * @created 2026-10-15
 * @module config-center
 */
import { describe, expect, it } from 'vitest';
import { envSchema } from '@fw/config';
import { ErrorCode } from '@fw/core';
import { ConfigCenterService } from '../center.js';
import type { ConfigHistoryPort, ConfigSnapshotEntry, ConfigWriteContext } from '../types.js';

/** 构建 env 快照（真实 zod 校验路径；未列出键取 schema 默认值） */
function makeEnv(): ReturnType<typeof envSchema.parse> {
  return envSchema.parse({
    APP_ENV: 'test',
    LOG_LEVEL: 'info',
    CACHE_TTL: '300',
    MQ_CONCURRENCY: '10',
    MQ_RATE_LIMIT: '0',
    OTEL_SAMPLE_RATIO: '0.1',
    TENANT_CACHE_TTL: '60',
  });
}

/** 内存事实源驱动桩：两个实例共享同一份 state（= 共享文件 / Nacos） */
function makeSharedDriver(shared: { state: Record<string, unknown> }) {
  return {
    kind: 'file' as const,
    pollSeconds: 5,
    async load() {
      return { ...shared.state };
    },
    async write(snapshot: Record<string, unknown>) {
      shared.state = { ...snapshot };
    },
    watch() {},
    async stop() {},
  };
}

/** 内存持久历史（ConfigHistoryPort 的最小实现：append upsert + 降序 list） */
function makeMemoryHistory(): ConfigHistoryPort & { rows: ConfigSnapshotEntry[] } {
  const rows: ConfigSnapshotEntry[] = [];
  return {
    rows,
    async append(entry) {
      const existing = rows.findIndex((r) => r.version === entry.version);
      if (existing >= 0) rows[existing] = { ...entry };
      else rows.push({ ...entry });
      rows.sort((a, b) => b.version - a.version);
      while (rows.length > 20) rows.pop();
    },
    async latest() {
      return rows.length > 0 ? { ...rows[0] } : null;
    },
    async findByVersion(version) {
      const found = rows.find((r) => r.version === version);
      return found ? { ...found } : null;
    },
    async list(limit) {
      return rows.slice(0, limit).map((r) => ({ ...r }));
    },
  };
}

/** 组装一个实例（共享事实源 + 共享历史） */
function makeInstance(sharedState: { state: Record<string, unknown> }, history: ConfigHistoryPort) {
  return new ConfigCenterService({ driver: makeSharedDriver(sharedState), env: makeEnv(), history });
}

const apiCtx: ConfigWriteContext = { source: 'api', operator: 'admin', operatorId: 'u1' };

describe('ConfigCenterService 多实例语义（M10 E-02）', () => {
  it('AC2：A 实例写入版本后，B 实例 syncRemoteVersion 与 meta.snapshotVersion 一致', async () => {
    const shared = { state: {} as Record<string, unknown> };
    const history = makeMemoryHistory();
    const instanceA = makeInstance(shared, history);
    const instanceB = makeInstance(shared, history);
    await instanceA.init();
    await instanceB.init();

    const result = await instanceA.write('log.level', 'debug', apiCtx);
    expect(result.snapshotVersion).toBe(2);

    // B 实例无需本地写操作，读取即对齐（GET /configs 的 meta 路径）
    const bVersion = await instanceB.syncRemoteVersion();
    expect(bVersion).toBe(2);
    expect(instanceB.meta().snapshotVersion).toBe(2);
  });

  it('AC2：B 实例回滚 A 实例写入的版本，结果一致且回滚计入历史', async () => {
    const shared = { state: {} as Record<string, unknown> };
    const history = makeMemoryHistory();
    const instanceA = makeInstance(shared, history);
    const instanceB = makeInstance(shared, history);
    await instanceA.init();
    await instanceB.init();

    await instanceA.write('log.level', 'debug', apiCtx); // v2
    // B 实例经事实源轮询追上 A 的覆盖（file/nacos 轮询的进程内等效），再回滚：
    // 候选集来自持久历史（含 A 写入的 v2），缺省目标 = 上一版 v1
    await instanceB.ingestExternal({ ...shared.state });
    const rollback = await instanceB.rollback(undefined, apiCtx);
    expect(rollback.toVersion).toBe(1);
    expect(rollback.changed).toEqual([{ key: 'log.level', oldValue: 'debug', newValue: 'info' }]);
    // 回滚本身计入历史（版本 3），A 侧同步可见
    expect(await instanceA.syncRemoteVersion()).toBe(3);
    // B 的生效值已回到 env 基线
    expect(instanceB.list().find((c) => c.key === 'log.level')?.value).toBe('info');
  });

  it('版本号以持久层为基线推进：B 在 A 写入后再写不撞号', async () => {
    const shared = { state: {} as Record<string, unknown> };
    const history = makeMemoryHistory();
    const instanceA = makeInstance(shared, history);
    const instanceB = makeInstance(shared, history);
    await instanceA.init();
    await instanceB.init();

    const first = await instanceA.write('log.level', 'debug', apiCtx); // v2
    const second = await instanceB.write('cache.ttl', 600, apiCtx); // v3（基线=A 的 v2）
    expect(first.snapshotVersion).toBe(2);
    expect(second.snapshotVersion).toBe(3);
    expect(await history.latest()).toMatchObject({ version: 3 });
  });

  it('反向验证：不注入 history 时保持 M9 原语义（本地计数、本地回滚候选）', async () => {
    const shared = { state: {} as Record<string, unknown> };
    const instanceA = new ConfigCenterService({ driver: makeSharedDriver(shared), env: makeEnv() });
    const instanceB = new ConfigCenterService({ driver: makeSharedDriver(shared), env: makeEnv() });
    await instanceA.init();
    await instanceB.init();

    await instanceA.write('log.level', 'debug', apiCtx);
    // B 未注入持久历史：版本号停留在自己的 1（原行为——跨实例一致性由部署层保证）
    expect(await instanceB.syncRemoteVersion()).toBe(1);
    // B 的回滚候选只有自己的启动快照，无「上一版」可回滚
    await expect(instanceB.rollback(undefined, apiCtx)).rejects.toMatchObject({
      code: ErrorCode.STATE_NOT_ALLOWED,
    });
  });
});

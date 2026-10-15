/*
 * @file 单测：配置中心端点（M9/PRD-009 FR-06）
 * @description 直接实例化 ConfigsController（不经 HTTP 层）验证端点契约：GET 返回键值列表与运行元信息、
 *   PUT 未启用 1004、缺 body.value 1001、透传管道错误（5001/5002/5003）、调用上下文（source/operator）。
 *   管道自身语义（校验/审计/回滚）见 @fw/config-center 包内单测。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/config-center
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@fw/core';
import { ConfigsController } from './configs.controller.js';
import type { ConfigCenterService, ConfigWriteResult } from '@fw/config-center';

/** 中心桩：write 记录调用并可注入错误 */
function makeCenter(writeImpl?: (key: string, value: unknown) => Promise<ConfigWriteResult>): ConfigCenterService & { writes: Array<{ key: string; value: unknown }> } {
  const center = {
    writes: [] as Array<{ key: string; value: unknown }>,
    list: vi.fn(() => [
      { key: 'log.level', value: 'info', source: 'env', hot: true as const, envKey: 'LOG_LEVEL', updatedAt: null },
      { key: 'cache.ttl', value: 600, source: 'runtime' as const, hot: true as const, envKey: 'CACHE_TTL', updatedAt: '2026-10-15T00:00:00.000Z' },
    ]),
    meta: vi.fn(() => ({ driver: 'file', snapshotVersion: 2, pollSeconds: 5, lastAppliedAt: '2026-10-15T00:00:00.000Z', lastError: null })),
    write: vi.fn(async (key: string, value: unknown, _ctx: unknown) => {
      if (writeImpl) return writeImpl(key, value);
      center.writes.push({ key, value });
      return { key, oldValue: 0, newValue: value, snapshotVersion: 3 };
    }),
  } as unknown as ConfigCenterService & { writes: Array<{ key: string; value: unknown }> };
  return center;
}

const user = { id: 'u1', username: 'admin' };

describe('ConfigsController（/api/v1/configs）', () => {
  it('GET：返回白名单键值列表与运行元信息', () => {
    const center = makeCenter();
    const controller = new ConfigsController(center, { enabled: true });

    const response = controller.list();

    expect(response.configs).toHaveLength(2);
    expect(response.meta).toMatchObject({ driver: 'file', snapshotVersion: 2 });
  });

  it('PUT：未启用 → 400/1004（零开销形态没有事实源，在线修改不可用）', async () => {
    const center = makeCenter();
    const controller = new ConfigsController(center, { enabled: false });

    await expect(controller.update('log.level', { value: 'debug' }, user.id, user.username, {} as never)).rejects.toMatchObject({
      code: ErrorCode.STATE_NOT_ALLOWED,
    });
  });

  it('PUT：缺 body.value → 400/1001', async () => {
    const center = makeCenter();
    const controller = new ConfigsController(center, { enabled: true });

    await expect(controller.update('log.level', {}, user.id, user.username, {} as never)).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
    });
    await expect(controller.update('log.level', undefined, user.id, user.username, {} as never)).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
    });
  });

  it('PUT：透传管道调用（source=api、operator=username、operatorId）', async () => {
    const center = makeCenter();
    const controller = new ConfigsController(center, { enabled: true });

    await controller.update('cache.ttl', { value: 900 }, user.id, user.username, {} as never);

    expect(center.write).toHaveBeenCalledWith('cache.ttl', 900, { source: 'api', operator: 'admin', operatorId: 'u1' });
  });

  it('PUT：管道错误原样冒泡（5001 boot 键 / 5002 非法值 / 5003 未知键）', async () => {
    const center = makeCenter(async (key) => {
      if (key === 'db.driver') throw Object.assign(new Error('不可热更'), { code: ErrorCode.CONFIG_NOT_HOT });
      if (key === 'log.level') throw Object.assign(new Error('非法'), { code: ErrorCode.CONFIG_INVALID_VALUE });
      throw Object.assign(new Error('不存在'), { code: ErrorCode.CONFIG_NOT_FOUND });
    });
    const controller = new ConfigsController(center, { enabled: true });

    await expect(controller.update('db.driver', { value: 'mysql' }, user.id, user.username, {} as never)).rejects.toMatchObject({
      code: ErrorCode.CONFIG_NOT_HOT,
    });
    await expect(controller.update('log.level', { value: 'verbose' }, user.id, user.username, {} as never)).rejects.toMatchObject({
      code: ErrorCode.CONFIG_INVALID_VALUE,
    });
    await expect(controller.update('nope.nope', { value: 1 }, user.id, user.username, {} as never)).rejects.toMatchObject({
      code: ErrorCode.CONFIG_NOT_FOUND,
    });
  });
});

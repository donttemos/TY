/*
 * @file 前端运行时上限 store 单元测试（M10/E-16）
 * @description 覆盖 web.keepAliveMax 的读取与兜底：配置中心下发合法值即应用；
 *   无该键 / 值越界 / 请求失败（无权限、未启用、网络异常）一律回退默认 12；
 *   一次会话只加载一次（失败不重试——无权限用户不会每次进布局都打必败请求）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/store
 */

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchConfigs = vi.fn();
vi.mock('@/api/config', () => ({
  fetchConfigs: (...args: unknown[]) => fetchConfigs(...args),
}));

const { DEFAULT_KEEP_ALIVE_MAX, useWebLimitsStore } = await import('../web-limits');

/** 构造 GET /configs 响应（白名单键列表 + 元信息） */
function configsResponse(entries: Array<{ key: string; value: unknown }>): { configs: Array<{ key: string; value: unknown }>; meta: Record<string, unknown> } {
  return { configs: entries, meta: {} };
}

describe('web-limits store（E-16 keep-alive 上限）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fetchConfigs.mockReset();
  });

  it('默认值 12（未加载前与后端 schema 默认值同口径）', () => {
    const limits = useWebLimitsStore();
    expect(limits.keepAliveMax).toBe(DEFAULT_KEEP_ALIVE_MAX);
    expect(DEFAULT_KEEP_ALIVE_MAX).toBe(12);
  });

  it('配置中心下发 web.keepAliveMax 合法值即应用', async () => {
    fetchConfigs.mockResolvedValue(configsResponse([
      { key: 'log.level', value: 'info' },
      { key: 'web.keepAliveMax', value: 30 },
    ]));
    const limits = useWebLimitsStore();
    await limits.load();
    expect(limits.keepAliveMax).toBe(30);
  });

  it('白名单无该键（旧后端）→ 保持默认值', async () => {
    fetchConfigs.mockResolvedValue(configsResponse([{ key: 'log.level', value: 'info' }]));
    const limits = useWebLimitsStore();
    await limits.load();
    expect(limits.keepAliveMax).toBe(DEFAULT_KEEP_ALIVE_MAX);
  });

  it('值越界（0 / 超上限 / 非整数）→ 保持默认值', async () => {
    for (const bad of [0, 1001, 12.5]) {
      fetchConfigs.mockResolvedValue(configsResponse([{ key: 'web.keepAliveMax', value: bad }]));
      setActivePinia(createPinia());
      const limits = useWebLimitsStore();
      await limits.load();
      expect(limits.keepAliveMax, `value=${String(bad)}`).toBe(DEFAULT_KEEP_ALIVE_MAX);
    }
  });

  it('请求失败（无 system:config:read / 未启用 / 网络异常）→ 回退默认值', async () => {
    fetchConfigs.mockRejectedValue(new Error('3002 无操作权限'));
    const limits = useWebLimitsStore();
    await limits.load();
    expect(limits.keepAliveMax).toBe(DEFAULT_KEEP_ALIVE_MAX);
  });

  it('一次会话只加载一次：重复 load 不重复请求（失败也不重试）', async () => {
    fetchConfigs.mockRejectedValue(new Error('network down'));
    const limits = useWebLimitsStore();
    await limits.load();
    await limits.load();
    await limits.load();
    expect(fetchConfigs).toHaveBeenCalledTimes(1);
  });
});

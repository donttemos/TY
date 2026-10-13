/*
 * @file 单测：redis 依赖懒加载与连接构造
 * @description 覆盖 loadIoredis（optional peer 解析成功路径）与 createRedisClient 的
 *   缺连接串快速失败（可操作报错）。不创建真实连接（避免悬挂重连计时器），
 *   真实 Redis 往返由冒烟脚本验证。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { describe, expect, it } from 'vitest';
import { TransportUnavailableError } from '../errors.js';
import { createRedisClient, loadIoredis } from '../drivers/redis-client.js';

describe('loadIoredis', () => {
  it('devDependencies 装有 ioredis 时解析出默认构造器', async () => {
    const mod = await loadIoredis();
    expect(typeof mod.default).toBe('function');
  });

  it('重复加载返回同一模块（懒加载缓存）', async () => {
    const first = await loadIoredis();
    const second = await loadIoredis();
    expect(second).toBe(first);
  });
});

describe('createRedisClient', () => {
  it('缺连接串（undefined / 空串）时快速失败并给出修复手段', async () => {
    await expect(createRedisClient(undefined)).rejects.toThrow(TransportUnavailableError);
    await expect(createRedisClient(undefined)).rejects.toThrow(/TRANSPORT_URL/);
    await expect(createRedisClient('')).rejects.toThrow(TransportUnavailableError);
  });
});

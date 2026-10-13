/*
 * @file DbModule 装配测试
 * @description 验证 forRoot 的动态模块结构（provider/export/global）、
 *   慢查询插桩注入、连接成功后 readinessProbe 被标记（T-M2-06 接线验证）。
 * @author donttemo
 * @created 2026-10-12
 * @module @fw/db
 */

import { describe, it, expect, vi } from 'vitest';
import { DbModule, DB_CLIENT } from '../db.module.js';
import type { PrismaClientLike } from '../types.js';

/** 可捕获 $extends 行为的 fake client */
function makeFakeClient() {
  const client = {
    testUser: {},
    $connect: vi.fn(async () => undefined),
    $disconnect: vi.fn(async () => undefined),
    $transaction: vi.fn(),
    $queryRaw: vi.fn(async () => []),
    $on: vi.fn(),
    $extends: vi.fn(function (this: unknown) { return this; }),
  };
  return client as unknown as PrismaClientLike;
}

describe('@fw/db · DbModule.forRoot 装配', () => {
  it('返回 global 动态模块并导出 DB_CLIENT', () => {
    const mod = DbModule.forRoot({ client: makeFakeClient(), provider: 'sqlite' });
    expect(mod.module).toBe(DbModule);
    expect(mod.global).toBe(true);
    expect(mod.exports).toContain(DB_CLIENT);
    expect(mod.providers).toHaveLength(1);
    expect(mod.providers[0]).toMatchObject({ provide: DB_CLIENT });
  });

  it('注入容器的是慢查询插桩版 client（$extends 被调用）', () => {
    const client = makeFakeClient();
    const mod = DbModule.forRoot({ client, provider: 'mysql' });
    expect(client.$extends).toHaveBeenCalledOnce();
    expect(mod.providers[0]).toHaveProperty('useValue');
  });

  it('连接成功后 readinessProbe.markConnected 被调用', async () => {
    const client = makeFakeClient();
    const probe = DbModule.readinessProbe('sqlite', 500);
    DbModule.forRoot({ client, provider: 'sqlite', readinessProbe: probe });
    // forRoot 内异步连接：等一个宏任务让 .then 链跑完
    await new Promise((res) => setTimeout(res, 10));
    expect(await probe.check()).toBe(true);
    expect(probe.stats().connected).toBe(true);
  });

  it('连接失败不崩溃（/ready 持续 503，启动入口负责报错）', async () => {
    const client = {
      ...makeFakeClient(),
      $connect: vi.fn(async () => { throw new Error('connection refused'); }),
    } as unknown as PrismaClientLike;
    const probe = DbModule.readinessProbe('postgresql', 500);
    expect(() => DbModule.forRoot({ client, provider: 'postgresql', readinessProbe: probe })).not.toThrow();
    await new Promise((res) => setTimeout(res, 10));
    expect(await probe.check()).toBe(false);
  });

  it('readinessProbe 工厂默认阈值 500ms', () => {
    const probe = DbModule.readinessProbe('sqlite');
    expect(probe.stats().slowQueryThresholdMs).toBe(500);
  });

  it('自定义慢查询阈值透传', () => {
    const probe = DbModule.readinessProbe('mysql', 1000);
    expect(probe.stats().slowQueryThresholdMs).toBe(1000);
  });
});

/*
 * @file 演示自检端点守卫契约（PRD-012 OBS-16 反向验证）
 * @description ① DEMO_ENDPOINTS_ENABLED 显式 true/false 优先；② 未设置按 APP_ENV=dev /
 *   NODE_ENV=development 判定（默认安全：非 dev 即关）；③ 关闭时 guard 抛 404（NotFound，
 *   不暴露端点存在性而非 403）；④ **四个自检控制器逐个挂载 guard**（元数据断言）。
 *   ④ 来自 2026-10-17 真机 W3 实测发现：DemoController 漏挂 @UseGuards（import 了但没加装饰器），
 *   APP_ENV=prod 下 /api/v1/demo/ok 仍 200，docs/46 §4 与实现漂移——本断言锁定四控制器全覆盖。
 * @author donttemo
 * @created 2026-10-17
 * @modified 2026-10-17 donttemo 真机实测修复：补四控制器 guard 挂载元数据断言（防再次漏挂）
 * @module example-api/common
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { DemoEndpointsGuard, isDemoEndpointsEnabled } from './demo-endpoints.guard.js';
import { DemoController } from '../modules/demo/demo.controller.js';
import { DemoQueueController } from '../modules/demo-queue/demo-queue.controller.js';
import { DemoTransportController } from '../modules/demo-transport/demo-transport.controller.js';
import { CacheDemoController } from '../modules/cache-demo/cache-demo.controller.js';

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of ['DEMO_ENDPOINTS_ENABLED', 'APP_ENV', 'NODE_ENV']) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  }
}

describe('M12 W3 · 演示端点开关（OBS-16）', () => {
  it('显式 DEMO_ENDPOINTS_ENABLED=true/false 优先于环境判定', () => {
    withEnv({ DEMO_ENDPOINTS_ENABLED: 'true', APP_ENV: 'prod' }, () => {
      expect(isDemoEndpointsEnabled()).toBe(true);
    });
    withEnv({ DEMO_ENDPOINTS_ENABLED: 'false', APP_ENV: 'dev' }, () => {
      expect(isDemoEndpointsEnabled()).toBe(false);
    });
  });

  it('未设置时默认判定：dev 开、prod/default 关（默认安全）', () => {
    withEnv({ APP_ENV: 'dev', NODE_ENV: undefined }, () => {
      expect(isDemoEndpointsEnabled()).toBe(true);
    });
    withEnv({ APP_ENV: 'prod', NODE_ENV: undefined }, () => {
      expect(isDemoEndpointsEnabled()).toBe(false);
    });
    withEnv({ APP_ENV: undefined, NODE_ENV: 'development' }, () => {
      expect(isDemoEndpointsEnabled()).toBe(true);
    });
    withEnv({ APP_ENV: undefined, NODE_ENV: 'production' }, () => {
      expect(isDemoEndpointsEnabled()).toBe(false);
    });
  });

  it('反向验证：关闭时 guard 抛 404（不暴露端点存在性）', () => {
    const guard = new DemoEndpointsGuard();
    withEnv({ DEMO_ENDPOINTS_ENABLED: 'false' }, () => {
      try {
        guard.canActivate();
        expect.unreachable('应抛出 NotFoundException');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
      }
    });
    withEnv({ DEMO_ENDPOINTS_ENABLED: 'true' }, () => {
      expect(guard.canActivate()).toBe(true);
    });
  });

  it('四个自检控制器全部挂载 DemoEndpointsGuard（元数据断言，防漏挂）', () => {
    const controllers = [DemoController, DemoQueueController, DemoTransportController, CacheDemoController];
    for (const controller of controllers) {
      const guards = (Reflect.getMetadata('__guards__', controller) ?? []) as unknown[];
      expect(guards, `${controller.name} 必须挂 DemoEndpointsGuard`).toContain(DemoEndpointsGuard);
    }
  });
});

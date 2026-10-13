/*
 * @file @Cacheable 装饰器单测
 * @description 验证默认 key（类名:方法名:参数哈希）与缓存命中、实例属性与全局实例两种解析路径、
 *   condition 短路、tags 占位展开、自定义 key，以及缺失 CacheService 时的明确报错。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Cacheable, expandTags, setGlobalCacheService } from '../cacheable.decorator.js';
import { CacheService } from '../cache.service.js';
import { hashArgs } from '../key.js';
import { MemoryCacheStore } from '../drivers/memory.driver.js';
import { makeOptions } from './test-helpers.js';

/** 构造缓存服务（无抖动、TTL 60s） */
function makeCache(): CacheService {
  return new CacheService({ store: new MemoryCacheStore(), options: makeOptions({ defaultTtlSeconds: 60 }) });
}

afterEach(() => {
  setGlobalCacheService(undefined);
});

describe('@fw/cache · @Cacheable', () => {
  it('实例属性注入：同参数第二次调用走缓存，回源只 1 次', async () => {
    const cache = makeCache();
    const repo = { hits: 0 };

    class UserService {
      readonly cacheService = cache;
      readonly repo = repo;

      @Cacheable({ ttl: 60, tags: ['user'] })
      async findUser(id: string): Promise<{ id: string }> {
        this.repo.hits++;
        return { id };
      }
    }

    const service = new UserService();
    expect(await service.findUser('1')).toEqual({ id: '1' });
    expect(await service.findUser('1')).toEqual({ id: '1' });
    expect(repo.hits).toBe(1);
    // 不同参数各自缓存
    await service.findUser('2');
    expect(repo.hits).toBe(2);
    // 缓存键按类名:方法名:参数哈希落盘
    expect(await cache.get(`UserService:findUser:${hashArgs(['1'])}`)).toEqual({ id: '1' });
  });

  it('全局实例兜底：未注入属性时用 CacheModule 注册的实例', async () => {
    const cache = makeCache();
    setGlobalCacheService(cache);

    class DictService {
      calls = 0;

      @Cacheable({ ttl: 60 })
      async load(code: string): Promise<string> {
        this.calls++;
        return `value-${code}`;
      }
    }

    const service = new DictService();
    expect(await service.load('sex')).toBe('value-sex');
    expect(await service.load('sex')).toBe('value-sex');
    expect(service.calls).toBe(1);
  });

  it('condition 为假时跳过缓存，每次真实调用', async () => {
    const cache = makeCache();

    class AuthService {
      readonly cacheService = cache;
      calls = 0;

      @Cacheable({ ttl: 60, condition: (anonymous: unknown) => anonymous === true })
      async profile(anonymous: boolean): Promise<string> {
        this.calls++;
        return `p-${anonymous}`;
      }
    }

    const service = new AuthService();
    await service.profile(false);
    await service.profile(false);
    expect(service.calls).toBe(2);
    await service.profile(true);
    await service.profile(true);
    expect(service.calls).toBe(3);
  });

  it('tags 占位展开为实际参数，可按标签批量失效', async () => {
    const cache = makeCache();

    class OrderService {
      readonly cacheService = cache;
      hits = 0;

      @Cacheable({ ttl: 60, tags: ['user:${0}'] })
      async listByUser(userId: string): Promise<string[]> {
        this.hits++;
        return [`order-of-${userId}`];
      }
    }

    const service = new OrderService();
    await service.listByUser('7');
    expect(cache.metricsSnapshot().tagInvalidations).toBe(0);
    expect(await cache.invalidateTag('user:7')).toBe(1);
    await service.listByUser('7');
    expect(service.hits).toBe(2);
  });

  it('自定义 key 覆盖默认生成规则', async () => {
    const cache = makeCache();

    class ReportService {
      readonly cacheService = cache;
      hits = 0;

      @Cacheable({ ttl: 60, key: 'report:daily' })
      async daily(day: string): Promise<string> {
        this.hits++;
        return `report-${day}`;
      }
    }

    const service = new ReportService();
    await service.daily('2026-10-13');
    await service.daily('2026-10-14');
    expect(service.hits).toBe(1);
    expect(await cache.get('report:daily')).toBe('report-2026-10-13');
  });

  it('同步方法同样可缓存（返回值自动 Promise 化）', async () => {
    const cache = makeCache();

    class SyncService {
      readonly cache = cache;
      hits = 0;

      @Cacheable({ ttl: 60 })
      compute(n: number): number {
        this.hits++;
        return n * 2;
      }
    }

    const service = new SyncService();
    expect(await service.compute(4)).toBe(8);
    expect(await service.compute(4)).toBe(8);
    expect(service.hits).toBe(1);
  });

  it('未注册任何 CacheService 时抛出明确错误', async () => {
    class BrokenService {
      @Cacheable({ ttl: 60 })
      async run(): Promise<string> {
        return 'x';
      }
    }

    await expect(new BrokenService().run()).rejects.toThrow(/未找到 CacheService/);
  });

  it('expandTags 对无占位与无标签的处理', () => {
    expect(expandTags(undefined, [])).toEqual([]);
    expect(expandTags(['dict'], ['a'])).toEqual(['dict']);
    expect(expandTags(['user:${0}', 'org:${1}'], ['u1', 'o9'])).toEqual(['user:u1', 'org:o9']);
  });

  it('@Cacheable 只能用于方法', () => {
    expect(() => {
      const descriptor: PropertyDescriptor = { value: 42 };
      Cacheable({ ttl: 60 })({}, 'prop', descriptor);
    }).toThrow(/只能作用于方法/);
  });
});

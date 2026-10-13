/*
 * @file 缓存演示服务（M4 验收载体）
 * @description 用真实业务形态演示 PRD-004 的能力：`@Cacheable` 装饰器缓存用户资料、`wrap` 回源包装
 *   与空值占位（防穿透）；内部按桶统计回源次数，供冒烟脚本断言「100 并发只回源 1 次」等 AC。
 *   缓存实例来自容器注入的属性 `cache`（@Cacheable 自动解析），业务签名零侵入。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/cache-demo
 */

import { Inject, Injectable } from '@nestjs/common';
import { CacheService, CACHE_SERVICE, Cacheable } from '@fw/cache';

/** 演示用户结构 */
export interface DemoUser {
  id: string;
  name: string;
}

/**
 * 缓存演示服务
 */
@Injectable()
export class CacheDemoService {
  /** 回源计数（桶 → 次数）：验证命中、单飞与标签失效 */
  private readonly loads = new Map<string, number>();

  constructor(@Inject(CACHE_SERVICE) private readonly cacheService: CacheService) {}

  /**
   * 装饰器缓存：同 id 第二次调用不回源；更新后可按标签 `demo:user:<id>` 失效
   * @param id 用户 ID
   */
  @Cacheable({ ttl: 60, tags: ['demo:user:${0}'] })
  async findUser(id: string): Promise<DemoUser> {
    this.bump(`user:${id}`);
    return { id, name: `user-${id}` };
  }

  /**
   * 回源包装：miss 参数为真时返回 null，写入空值占位（防穿透）
   * @param key 逻辑键
   * @param miss 是否模拟「数据不存在」
   * @param delayMs 回源耗时（毫秒，放大并发窗口以便验证单飞）
   */
  async loadOrMiss(key: string, miss: boolean, delayMs = 0): Promise<string | undefined> {
    return this.cacheService.wrap(`demo:item:${key}`, 60, async () => {
      this.bump(`item:${key}`);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return miss ? null : `item-${key}`;
    });
  }

  /**
   * 读取并写入一个键（验证统一接口与前缀）
   * @param key 逻辑键
   * @param value 值
   */
  async put(key: string, value: string): Promise<void> {
    await this.cacheService.set(`demo:kv:${key}`, value, { ttlSeconds: 60 });
  }

  /**
   * 读取一个键
   * @param key 逻辑键
   */
  async pick(key: string): Promise<string | undefined> {
    return this.cacheService.get<string>(`demo:kv:${key}`);
  }

  /**
   * 按标签失效
   * @param tag 标签
   */
  async invalidate(tag: string): Promise<number> {
    return this.cacheService.invalidateTag(tag);
  }

  /**
   * 获取锁并保持指定时长（演示集群内只跑一次）
   * @param key 锁键
   * @param holdMs 持有时长（毫秒）
   */
  async holdLock(key: string, holdMs: number): Promise<boolean> {
    const handle = await this.cacheService.lock(`demo:${key}`, Math.ceil(holdMs / 1000) + 5);
    if (!handle) return false;
    const timer = setTimeout(() => {
      void handle.release();
    }, holdMs);
    timer.unref?.();
    return true;
  }

  /**
   * 尝试获取并立即释放锁（用于判断当前是否被占用）
   * @param key 锁键
   */
  async tryLock(key: string): Promise<boolean> {
    const handle = await this.cacheService.lock(`demo:${key}`, 5);
    if (!handle) return false;
    await handle.release();
    return true;
  }

  /** 按桶或总计读取回源次数 */
  loadCount(bucket?: string): number {
    if (bucket) return this.loads.get(bucket) ?? 0;
    let total = 0;
    for (const count of this.loads.values()) total += count;
    return total;
  }

  /** 清空回源计数（冒烟脚本分阶段复位） */
  resetCounts(): void {
    this.loads.clear();
  }

  /** 指标快照（含命中率派生值） */
  stats(): { driver: string; hits: number; misses: number; hitRate: number; singleFlightMerged: number; tagInvalidations: number; degradations: number } {
    const snapshot = this.cacheService.metricsSnapshot();
    const total = snapshot.hits + snapshot.misses;
    return {
      driver: snapshot.driver,
      hits: snapshot.hits,
      misses: snapshot.misses,
      hitRate: total === 0 ? 0 : Number((snapshot.hits / total).toFixed(6)),
      singleFlightMerged: snapshot.singleFlightMerged,
      tagInvalidations: snapshot.tagInvalidations,
      degradations: snapshot.degradations,
    };
  }

  /** 回源次数 +1 */
  private bump(bucket: string): void {
    this.loads.set(bucket, (this.loads.get(bucket) ?? 0) + 1);
  }
}

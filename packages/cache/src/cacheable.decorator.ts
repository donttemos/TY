/*
 * @file @Cacheable 方法装饰器
 * @description 在方法上加 `@Cacheable({ ttl: 300, tags: ['user'] })` 即完成缓存（PRD-004 FR-03）：
 *   默认 key 为 `<类名>:<方法名>:<参数稳定哈希>`，支持自定义 key、`condition` 短路、`tags` 占位展开
 *   （`user:${0}` 取第 0 个参数）。缓存实例来源：实例属性 `cacheService` / `cache`，
 *   或 CacheModule.forRoot() 注册的全局实例（接口层无侵入，不改业务签名）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-02）：裸抛迁移至 BizError 统一码（ADR-0025 三类治理）
 * @module @fw/cache
 */

import { hashArgs } from './key.js';
import { BizError, ErrorCode } from '@fw/core';
import type { CacheService } from './cache.service.js';

/** `@Cacheable` 选项（与 C-04 契约 CacheableOptions 同源） */
export interface CacheableOptions {
  /** TTL（秒） */
  ttl: number;
  /** 关联标签；支持 `${参数索引}` 占位 */
  tags?: string[];
  /** 完整覆盖默认 key */
  key?: string;
  /** 为假时跳过缓存（不读不写） */
  condition?: (...args: unknown[]) => boolean;
  /** 空值占位 TTL（秒） */
  nullTtlSeconds?: number;
  /** TTL 抖动比例（0–1） */
  jitter?: number;
}

/** 全局缓存实例（CacheModule.forRoot 注册；仅用于装饰器兜底查找） */
let globalCacheService: CacheService | undefined;

/**
 * 注册全局缓存实例（由 CacheModule 调用；测试可显式设置）
 * @param service 缓存服务实例，传 undefined 清除
 */
export function setGlobalCacheService(service: CacheService | undefined): void {
  globalCacheService = service;
}

/**
 * 从实例或全局注册表解析缓存服务
 * @param target 方法所属实例
 * @returns 缓存服务；未找到返回 undefined
 */
export function resolveCacheService(target: unknown): CacheService | undefined {
  const holder = target as Record<string, unknown> | null | undefined;
  const candidate = holder?.cacheService ?? holder?.cache;
  if (candidate && typeof (candidate as CacheService).wrap === 'function') return candidate as CacheService;
  return globalCacheService;
}

/**
 * 缓存方法返回值：命中直接返回，未命中回源并写缓存，并发同 key 单飞合并
 * @param options TTL 与标签等配置
 */
export function Cacheable(options: CacheableOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): PropertyDescriptor => {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    if (typeof original !== 'function') {
      throw new BizError(ErrorCode.BAD_REQUEST, `@Cacheable 只能作用于方法（${String(propertyKey)}）`);
    }
    const className = target.constructor?.name ?? 'Anonymous';
    const methodName = String(propertyKey);

    descriptor.value = async function cacheableWrapper(this: unknown, ...args: unknown[]): Promise<unknown> {
      const service = resolveCacheService(this);
      if (!service) {
        throw new BizError(
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          `@Cacheable 未找到 CacheService：请在 ${className}.${methodName} 所在类注入 cacheService 属性，或先调用 CacheModule.forRoot()`,
        );
      }
      if (options.condition && !options.condition(...args)) {
        return original.apply(this, args);
      }
      const key = options.key ?? `${className}:${methodName}:${hashArgs(args)}`;
      return service.wrap(
        key,
        options.ttl,
        // 回源结果统一 Promise 化，兼容同步方法
        () => Promise.resolve(original.apply(this, args)) as Promise<unknown>,
        {
          tags: expandTags(options.tags, args),
          nullTtlSeconds: options.nullTtlSeconds,
          jitter: options.jitter,
        },
      );
    };
    return descriptor;
  };
}

/**
 * 展开标签占位：`user:${0}` → `user:123`
 * @param tags 标签模板
 * @param args 方法参数
 */
export function expandTags(tags: string[] | undefined, args: readonly unknown[]): string[] {
  if (!tags || tags.length === 0) return [];
  return tags.map((tag) => tag.replace(/\$\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])));
}

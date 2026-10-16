/*
 * @file 鉴权缓存适配器（CacheService → AuthCachePort）
 * @description M3 遗留项②的落地：把 @fw/cache 的 CacheService 适配为 @fw/auth 的 AuthCachePort，
 *   使权限缓存 / 令牌黑名单 / 登录限流锁定在 CACHE_DRIVER 切换后自动共享到 Redis（多实例一致）。
 *   应用侧适配器（不放进框架包）：@fw/auth 不依赖 @fw/cache，只认端口结构。
 *   键规范化：鉴权缓存键含 `ip|account` 等非白名单字符，超集键改用 base64url（可逆、无碰撞、
 *   仍满足缓存键白名单），标签同样规范化，保证写入与失效命中同一键。
 * @author donttemo
 * @created 2026-10-13
 * @module __APP_NAME__/auth
 */

import { Inject, Injectable } from '@nestjs/common';
import type { AuthCachePort } from '@fw/auth';
import { CacheService, CACHE_SERVICE } from '@fw/cache';

/** 缓存键白名单（与 @fw/cache 的 key 规范一致） */
const SAFE_KEY_RE = /^[A-Za-z0-9:._\-#@/]+$/;

/**
 * 把 CacheService 适配为 AuthCachePort
 */
@Injectable()
export class CacheBackedAuthCache implements AuthCachePort {
  constructor(@Inject(CACHE_SERVICE) private readonly cache: CacheService) {}

  /** 读取（键规范化后透传） */
  async get<T>(key: string): Promise<T | undefined> {
    return this.cache.get<T>(normalize(key));
  }

  /** 写入（ttlSeconds 必须为正，由 CacheService 强校验） */
  async set(key: string, value: unknown, ttlSeconds: number, tags?: string[]): Promise<void> {
    await this.cache.set(normalize(key), value, { ttlSeconds, tags: tags?.map(normalize) });
  }

  /** 删除单个键 */
  async del(key: string): Promise<void> {
    await this.cache.del(normalize(key));
  }

  /** 按标签失效（如权限变更后的 `user:<id>`） */
  async invalidateTag(tag: string): Promise<void> {
    await this.cache.invalidateTag(normalize(tag));
  }
}

/**
 * 键规范化：满足白名单的键原样返回，否则 base64url 编码（字符集 A-Za-z0-9-_，仍在白名单内）
 * @param key 原始键或标签
 */
export function normalize(key: string): string {
  return SAFE_KEY_RE.test(key) ? key : `b64_${Buffer.from(key, 'utf8').toString('base64url')}`;
}

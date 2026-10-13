/*
 * @file 装配期扫描：@TransportHandler
 * @description 应用启动时从 Nest 容器里发现标注了 `@TransportHandler` 的类实例，
 *   由 TransportService 统一注册。扫描器以最小接口描述，便于单元测试用手写桩替代 Nest 容器。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { readTransportHandlerAddress } from './decorators.js';

/** Nest 容器中的 provider 包装器（框架用到的最小子集） */
export interface ProviderLike {
  /** 类实例（未实例化的 provider 为 undefined） */
  instance?: unknown;
}

/** 扫描到的传输处理器 */
export interface ScannedTransportHandler {
  /** 传输地址（`@TransportHandler` 入参） */
  address: string;
  /** 类实例 */
  instance: object;
}

/**
 * 扫描 `@TransportHandler` 标注的类实例
 * @param providers Nest 容器的 provider 列表
 * @returns 处理器列表（按容器顺序，实例去重）
 */
export function scanTransportHandlers(providers: readonly ProviderLike[]): ScannedTransportHandler[] {
  const out: ScannedTransportHandler[] = [];
  const seen = new Set<object>();
  for (const provider of providers) {
    const instance = provider.instance;
    if (!instance || typeof instance !== 'object' || seen.has(instance)) continue;
    seen.add(instance);
    const constructor = instance.constructor;
    const address = readTransportHandlerAddress(constructor);
    if (!address) continue;
    out.push({ address, instance });
  }
  return out;
}

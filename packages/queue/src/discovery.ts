/*
 * @file 装配期扫描：@JobHandler 与 @Cron
 * @description 应用启动时从 Nest 容器里发现标注了 `@JobHandler` 的类实例（注册为任务处理器）
 *   与标注了 `@Cron` 的方法（注册为定时任务），业务无需手写注册代码。
 *   扫描器以最小接口描述，便于单元测试用手写桩替代 Nest 的 MetadataScanner。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { readCronMeta, readIdempotentMeta, readJobHandlerName, type IdempotentMeta } from './decorators.js';
import type { CronOptions } from './types.js';

/** Nest 容器中的 provider 包装器（框架用到的最小子集） */
export interface ProviderLike {
  /** 类实例（未实例化的 provider 为 undefined） */
  instance?: unknown;
}

/** 方法扫描器最小接口（Nest MetadataScanner 天然满足） */
export interface MetadataScannerLike {
  /**
   * 列出原型上的全部方法名
   * @param prototype 原型对象
   */
  getAllMethodNames(prototype: object): string[];
}

/** 扫描到的 Job 处理器 */
export interface ScannedHandler {
  /** 任务名（`@JobHandler` 入参） */
  name: string;
  /** 类实例 */
  instance: object;
  /** 幂等元数据 */
  idempotent?: IdempotentMeta;
}

/** 扫描到的定时任务 */
export interface ScannedCron {
  /** 任务名（缺省 `<类名>.<方法名>`） */
  name: string;
  /** cron 表达式 */
  expression: string;
  /** 选项 */
  options: CronOptions;
  /** 绑定好 this 的执行体 */
  handler: () => Promise<void> | void;
}

/**
 * 扫描 `@JobHandler` 标注的类实例
 * @param providers Nest 容器的 provider 列表
 * @returns 处理器列表
 */
export function scanJobHandlers(providers: readonly ProviderLike[]): ScannedHandler[] {
  const out: ScannedHandler[] = [];
  const seen = new Set<object>();
  for (const provider of providers) {
    const instance = provider.instance;
    if (!instance || typeof instance !== 'object' || seen.has(instance)) continue;
    seen.add(instance);
    const constructor = instance.constructor;
    const name = readJobHandlerName(constructor);
    if (!name) continue;
    out.push({ name, instance, idempotent: readIdempotentMeta(undefined, constructor) });
  }
  return out;
}

/**
 * 扫描 `@Cron` 标注的方法
 * @param providers Nest 容器的 provider 列表
 * @param scanner 方法扫描器
 * @returns 定时任务列表
 */
export function scanCrons(providers: readonly ProviderLike[], scanner: MetadataScannerLike): ScannedCron[] {
  const out: ScannedCron[] = [];
  const seen = new Set<object>();
  for (const provider of providers) {
    const instance = provider.instance;
    if (!instance || typeof instance !== 'object' || seen.has(instance)) continue;
    seen.add(instance);
    const prototype = Object.getPrototypeOf(instance) as object;
    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const method = (prototype as Record<string, unknown>)[methodName];
      if (typeof method !== 'function') continue;
      const meta = readCronMeta(method);
      if (!meta) continue;
      out.push({
        name: meta.options.name ?? `${instance.constructor.name}.${methodName}`,
        expression: meta.expression,
        options: meta.options,
        handler: () => (method as (this: object) => Promise<void> | void).call(instance),
      });
    }
  }
  return out;
}

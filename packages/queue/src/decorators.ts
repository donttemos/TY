/*
 * @file 装饰器：@JobHandler / @Cron / @Idempotent
 * @description 声明式注册入口（PRD-007 FR-01/FR-03/FR-05）：
 *   - `@JobHandler('order.timeout')` 标注在实现类上，应用启动时按名字注册 `handle`；
 *   - `@Cron('0 2 * * *', { lock: true })` 标注在方法上，启动时注册定时任务，默认加分布式锁；
 *   - `@Idempotent()` 标注在实现类或 `handle` 方法上，未显式给 `idempotencyKey` 时按载荷哈希去重。
 *   元数据键由本文件导出，供 QueueService / 调度器在装配期扫描（不依赖 Nest 反射以外的机制）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import 'reflect-metadata';
import type { CronOptions } from './types.js';

/** 处理器元数据键 */
export const META_JOB_HANDLER = 'fw:queue:job-handler';

/** cron 元数据键 */
export const META_CRON = 'fw:queue:cron';

/** 幂等元数据键 */
export const META_IDEMPOTENT = 'fw:queue:idempotent';

/** 幂等选项 */
export interface IdempotentOptions {
  /**
   * 幂等键推导函数（缺省用 `任务名:载荷哈希`）
   * @param payload 任务载荷
   */
  key?: (payload: never) => string;
  /** 幂等窗口（秒），默认 `MQ` 运行时默认值（3600） */
  ttlSeconds?: number;
}

/** 幂等元数据 */
export interface IdempotentMeta {
  /** 幂等键推导函数（可选） */
  key?: (payload: unknown) => string;
  /** 幂等窗口（秒） */
  ttlSeconds?: number;
}

/** cron 元数据 */
export interface CronMeta {
  /** cron 表达式 */
  expression: string;
  /** 选项 */
  options: CronOptions;
}

/**
 * 声明 Job 处理器（标注在实现类上）
 * @param name 任务名（全局唯一注册键）
 * @returns 类装饰器
 * @example
 * ```ts
 * @JobHandler('order.timeout')
 * export class OrderTimeoutJob implements Job<{ orderId: string }> {
 *   async handle(payload: { orderId: string }): Promise<void> { ... }
 * }
 * ```
 */
export function JobHandler(name: string): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(META_JOB_HANDLER, name, target);
  };
}

/**
 * 声明定时任务（标注在方法上）
 * @param expression cron 表达式（5 段或 6 段）
 * @param options 选项（`lock` 默认 true）
 * @returns 方法装饰器
 * @example
 * ```ts
 * @Cron('0 2 * * *', { lock: true })
 * async dailySettle(): Promise<void> { ... }
 * ```
 */
export function Cron(expression: string, options: CronOptions = {}): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    Reflect.defineMetadata(META_CRON, { expression, options } satisfies CronMeta, descriptor.value as object);
    void target;
    void propertyKey;
  };
}

/**
 * 声明幂等（标注在实现类或 `handle` 方法上）
 * @param options 幂等选项
 * @returns 类 / 方法装饰器
 * @example
 * ```ts
 * @Idempotent({ ttlSeconds: 3600 })
 * @JobHandler('order.notify')
 * export class OrderNotifyJob implements Job<{ orderId: string }> { ... }
 * ```
 */
export function Idempotent(options: IdempotentOptions = {}): ClassDecorator & MethodDecorator {
  const meta: IdempotentMeta = { key: options.key as ((payload: unknown) => string) | undefined, ttlSeconds: options.ttlSeconds };
  return ((target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor?.value) {
      Reflect.defineMetadata(META_IDEMPOTENT, meta, descriptor.value as object);
      return;
    }
    Reflect.defineMetadata(META_IDEMPOTENT, meta, target);
  }) as ClassDecorator & MethodDecorator;
}

/**
 * 读取类上的处理器名
 * @param target 类或实例
 */
export function readJobHandlerName(target: object): string | undefined {
  return Reflect.getMetadata(META_JOB_HANDLER, target) as string | undefined;
}

/**
 * 读取方法上的 cron 元数据
 * @param method 方法函数
 */
export function readCronMeta(method: object): CronMeta | undefined {
  return Reflect.getMetadata(META_CRON, method) as CronMeta | undefined;
}

/**
 * 读取幂等元数据（先看方法，再看类）
 * @param method 方法函数
 * @param owner 所属类或实例
 */
export function readIdempotentMeta(method: object | undefined, owner: object): IdempotentMeta | undefined {
  return (
    (method ? (Reflect.getMetadata(META_IDEMPOTENT, method) as IdempotentMeta | undefined) : undefined) ??
    (Reflect.getMetadata(META_IDEMPOTENT, owner) as IdempotentMeta | undefined)
  );
}

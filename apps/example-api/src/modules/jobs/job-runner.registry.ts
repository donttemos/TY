/*
 * @file 任务执行体注册表（M10 E-01）
 * @description `type → runner factory` 的进程内注册表：db / bullmq 驱动下，重跑请求可能落在
 *   非派发实例——闭包不可序列化也不落盘，重跑时只能按任务类型 + 持久化的 params 重建执行体。
 *   调用方（audit / tenant 控制器）在构造期把 factory 注册进来；未注册的类型在重跑时得到
 *   可读 reason（不静默失败），派发期（bullmq 驱动）缺失 factory 则直接拒绝派发。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import { Logger } from '@fw/logger';
import type { JobRunner } from './job-center.port.js';

const logger = Logger.for('jobs');

/** 执行体工厂：按持久化的业务入参重建 runner（闭包捕获的 service 依赖在 factory 闭包里） */
export type JobRunnerFactory = (params: Record<string, unknown>) => JobRunner;

/**
 * 任务执行体注册表
 */
export class JobRunnerRegistry {
  private readonly factories = new Map<string, JobRunnerFactory>();

  /**
   * 注册任务类型的执行体工厂（同类型重复注册覆盖并告警——注册发生在构造期，属编程错误）
   * @param type 任务类型（与派发时的 create.type 一致）
   * @param factory 执行体工厂
   */
  register(type: string, factory: JobRunnerFactory): void {
    if (this.factories.has(type)) {
      logger.warn('任务执行体工厂重复注册，后者覆盖前者', { type });
    }
    this.factories.set(type, factory);
  }

  /** 是否已注册该任务类型 */
  has(type: string): boolean {
    return this.factories.has(type);
  }

  /**
   * 按类型与业务入参重建执行体
   * @returns 未注册类型返回 null（调用方给出可读 reason）
   */
  resolve(type: string, params: Record<string, unknown> | null | undefined): JobRunner | null {
    const factory = this.factories.get(type);
    if (!factory) return null;
    return factory(params ?? {});
  }
}

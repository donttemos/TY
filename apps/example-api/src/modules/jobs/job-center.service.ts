/*
 * @file 异步任务中心门面（N-02 / M10 E-01）
 * @description 按 `JOB_CENTER_DRIVER` 装配的任务中心入口：memory（默认，N-02 原行为，
 *   进程内登记表）/ db（`jobs` 表登记 + 派发实例执行）/ bullmq（`jobs` 表登记 + 队列分发执行）。
 *   门面转发驱动实现——memory 下 get/retry/artifact 保持同步（既有单测零改动兼容），
 *   db/bullmq 下返回 Promise（控制器统一 await，Nest 两种形态都接受）。
 *   类型从 job-center.port.ts re-export，保持既有 import 路径不变。
 * @modified 2026-10-15 donttemo M10 E-01：原实现整体迁入 drivers/job-memory.driver.ts，
 *   本文件改为驱动门面（签名兼容：无参构造 = memory 驱动 = N-02 原行为）
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import { Injectable } from '@nestjs/common';
import type {
  JobArtifact,
  JobCenterDriverName,
  JobCenterPort,
  JobCreateOptions,
  JobRunner,
  JobView,
} from './job-center.port.js';
import { MemoryJobDriver } from './drivers/job-memory.driver.js';

export type { JobArtifact, JobCenterDriverName, JobCreateOptions, JobReporter, JobRunner, JobStatus, JobView } from './job-center.port.js';
export { JOB_CENTER_DRIVER_VALUES } from './job-center.port.js';

/**
 * 异步任务中心（驱动门面）
 */
@Injectable()
export class JobCenterService implements JobCenterPort {
  private readonly driver: JobCenterPort;

  /**
   * @param driver 驱动实现（缺省 = memory 驱动 = N-02 原行为；DI 场景由 JobsModule.forRoot 按环境装配）
   */
  constructor(driver?: JobCenterPort) {
    this.driver = driver ?? new MemoryJobDriver();
  }

  /** 当前驱动名（供 /ready 与运维面展示） */
  get kind(): JobCenterDriverName {
    return this.driver.kind;
  }

  /** 派发任务：立即返回视图（status=pending），执行在后台进行 */
  create(options: JobCreateOptions): JobView {
    return this.driver.create(options);
  }

  /** 读取任务视图（memory 同步 / db·bullmq 返回 Promise，调用方统一 await） */
  get(id: string, ownerId: string): JobView | null | Promise<JobView | null> {
    return this.driver.get(id, ownerId);
  }

  /** 原地重跑（memory 同步 / db·bullmq 返回 Promise，调用方统一 await） */
  retry(id: string, ownerId: string): { view: JobView | null; reason?: string } | Promise<{ view: JobView | null; reason?: string }> {
    return this.driver.retry(id, ownerId);
  }

  /** 取任务产物（memory 同步 / db·bullmq 返回 Promise，调用方统一 await） */
  artifact(id: string, ownerId: string): JobArtifact | null | Promise<JobArtifact | null> {
    return this.driver.artifact(id, ownerId);
  }
}

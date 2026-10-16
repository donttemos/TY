/*
 * @file 异步任务模块（N-02 / M10 E-01）
 * @description 按 `JOB_CENTER_DRIVER` 装配任务中心，并以 @Global 暴露 JobCenterService——
 *   任务中心是横切能力（审计导出、租户迁移都往里派发），逐个业务模块 import 只会徒增样板。
 *   装配矩阵：
 *   memory（默认）—— 仅门面 + 注册表，零持久化（N-02 原行为）；
 *   db          —— 门面 + PrismaJobStore（jobs 表）+ 执行体注册表（执行在派发实例）；
 *   bullmq      —— 门面 + PrismaJobStore + 注册表 + QueueService 分发（消费 handler
 *                  `job-center.execute` 读库重建 runner 执行写库；队列形态随 MQ_DRIVER）。
 *   db/bullmq 驱动下 JobRunnerRegistry 必须有任务类型的 factory（闭包不可跨实例/不落盘）。
 * @modified 2026-10-15 donttemo M10 E-01：静态模块改为 forRoot() 动态装配（app.module 同步改调用），
 *   按环境变量选驱动；bullmq 形态在装配期注册消费 handler
 * @modified 2026-10-15 donttemo M10/E-16：产物体积上限经 JOB_ARTIFACT_MAX_MB 配置（MB → 字符数），
 *   memory / db / bullmq 三驱动同口径注入，缺省 20MB 与 N-02 行为一致
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { DB_CLIENT, type PrismaClientLike } from '@fw/db';
import { loadEnv } from '@fw/config';
import { Logger } from '@fw/logger';
import { QUEUE_SERVICE, type QueueService } from '@fw/queue';
import { JobExecutor } from './job-executor.js';
import { JobCenterService } from './job-center.service.js';
import type { JobCenterPort } from './job-center.port.js';
import { MemoryJobDriver } from './drivers/job-memory.driver.js';
import { JobRunnerRegistry } from './job-runner.registry.js';
import { JobsController } from './jobs.controller.js';
import { PrismaJobStore, type JobStore } from './jobs.store.js';
import { DbJobDriver } from './drivers/job-db.driver.js';
import { BullmqJobDriver, JOB_CENTER_EXECUTE_HANDLER } from './drivers/job-bullmq.driver.js';

/** 任务中心驱动令牌（内部装配用） */
export const JOB_CENTER_DRIVER_TOKEN = 'FW_JOB_CENTER_DRIVER';

/** 任务登记存储令牌（内部装配用） */
export const JOB_STORE_TOKEN = 'FW_JOB_STORE';

const logger = Logger.for('jobs');

/** bullmq 消费载荷形状（与 drivers/job-bullmq.driver.ts 的 JobExecutePayload 一致） */
interface JobExecutePayload {
  jobId: string;
  type: string;
}

/**
 * 异步任务模块（全局）
 */
@Global()
@Module({})
export class JobsModule {
  /**
   * 装配任务中心（按 JOB_CENTER_DRIVER 选驱动）
   * @returns 动态模块定义
   */
  static forRoot(): DynamicModule {
    const driverName = loadEnv().JOB_CENTER_DRIVER;
    // M10/E-16：任务产物体积上限（MB → 字符数）——memory 与 db/bullmq 驱动同口径，缺省 20MB
    const maxArtifactChars = loadEnv().JOB_ARTIFACT_MAX_MB * 1024 * 1024;

    // 执行体注册表：单例，业务控制器在构造期登记 factory（多副本重跑的重建依据）
    const registryProvider: Provider = JobRunnerRegistry;
    const providers: Provider[] = [registryProvider];

    if (driverName === 'memory') {
      providers.push({
        provide: JOB_CENTER_DRIVER_TOKEN,
        useFactory: (): JobCenterPort => new MemoryJobDriver({ maxArtifactChars }),
      });
    } else {
      // db / bullmq 共用持久层（jobs 表）
      providers.push({
        provide: JOB_STORE_TOKEN,
        useFactory: (client: PrismaClientLike): JobStore => new PrismaJobStore(client),
        inject: [DB_CLIENT],
      });
      if (driverName === 'db') {
        providers.push({
          provide: JOB_CENTER_DRIVER_TOKEN,
          useFactory: (store: JobStore, registry: JobRunnerRegistry): JobCenterPort =>
            new DbJobDriver(store, registry, { maxArtifactChars }),
          inject: [JOB_STORE_TOKEN, JobRunnerRegistry],
        });
      } else {
        providers.push({
          provide: JOB_CENTER_DRIVER_TOKEN,
          useFactory: (store: JobStore, registry: JobRunnerRegistry, queue: QueueService): JobCenterPort => {
            // 消费侧 handler：读库 → 按 type + params 重建 runner → 执行写库（与 db 驱动同一 JobExecutor）
            const executor = new JobExecutor(store, { maxArtifactChars });
            queue.register<JobExecutePayload>(JOB_CENTER_EXECUTE_HANDLER, async (payload) => {
              const row = await store.findById(payload.jobId);
              if (!row) {
                logger.warn('队列任务登记缺失，跳过执行', { jobId: payload.jobId, type: payload.type });
                return;
              }
              const runner = registry.resolve(row.type, row.params);
              if (!runner) {
                await store.update(payload.jobId, {
                  status: 'failed',
                  error: `任务类型 ${row.type} 未注册执行体工厂，无法执行`,
                  message: '执行失败，可重试',
                });
                return;
              }
              await executor.execute(row, runner);
            });
            return new BullmqJobDriver(store, registry, queue);
          },
          inject: [JOB_STORE_TOKEN, JobRunnerRegistry, QUEUE_SERVICE],
        });
      }
    }

    return {
      module: JobsModule,
      global: true,
      providers: [
        ...providers,
        {
          provide: JobCenterService,
          useFactory: (driver: JobCenterPort): JobCenterService => new JobCenterService(driver),
          inject: [JOB_CENTER_DRIVER_TOKEN],
        },
      ],
      controllers: [JobsController],
      exports: [JobCenterService, JobRunnerRegistry],
    };
  }
}

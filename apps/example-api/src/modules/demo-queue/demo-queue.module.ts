/*
 * @file 队列演示模块（M7 验收载体）
 * @description 注册演示任务（@JobHandler/@Cron 载体）、台账服务与演示控制器；
 *   队列与调度器由 app.module 中的 QueueModule.forRoot 装配（@Global），本模块只消费注入能力。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/demo-queue
 */

import { Module } from '@nestjs/common';
import { DemoQueueController } from './demo-queue.controller.js';
import { DemoCronJobs, DemoEchoJob, DemoFlakyJob, DemoIdempotentJob, DemoPermanentJob, DemoSlowJob } from './demo-queue.jobs.js';
import { DemoQueueService } from './demo-queue.service.js';
import { QueueLedger } from './queue-ledger.js';

/**
 * 队列演示模块
 */
@Module({
  controllers: [DemoQueueController],
  providers: [
    QueueLedger,
    DemoEchoJob,
    DemoFlakyJob,
    DemoPermanentJob,
    DemoSlowJob,
    DemoIdempotentJob,
    DemoCronJobs,
    DemoQueueService,
  ],
  exports: [DemoQueueService, QueueLedger],
})
export class DemoQueueModule {}

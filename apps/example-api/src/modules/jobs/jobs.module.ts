/*
 * @file 异步任务模块（N-02）
 * @description 登记异步任务中心与通用任务端点，并以 @Global 暴露 JobCenterService——
 *   任务中心是横切能力（审计导出、租户迁移都往里派发），逐个业务模块 import 只会徒增样板。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import { Global, Module } from '@nestjs/common';
import { JobCenterService } from './job-center.service.js';
import { JobsController } from './jobs.controller.js';

/**
 * 异步任务模块（全局）
 */
@Global()
@Module({
  controllers: [JobsController],
  providers: [JobCenterService],
  exports: [JobCenterService],
})
export class JobsModule {}

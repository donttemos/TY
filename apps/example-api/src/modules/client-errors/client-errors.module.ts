/*
 * @file 前端错误上报模块（M10/E-17）
 * @description 装配 RUM 接收面：控制器（@Public 摄取端点）+ 服务（error 级结构化日志 +
 *   进程内计数）。零持久化、零外部依赖——观测旁路不接业务库，多实例合计走日志侧聚合。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/client-errors
 */

import { Module } from '@nestjs/common';
import { ClientErrorsController } from './client-errors.controller.js';
import { ClientErrorsService } from './client-errors.service.js';

/**
 * 前端错误上报模块
 */
@Module({
  controllers: [ClientErrorsController],
  providers: [ClientErrorsService],
  exports: [ClientErrorsService],
})
export class ClientErrorsModule {}

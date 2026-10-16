/*
 * @file SSE 实时推送模块（M10 E-12）
 * @description 装配统一 SSE 通道：`EventsService`（事件源汇装配 + 票据 + 积压巡检）与
 *   `EventsController`（`POST /events/ticket`、`GET /events/stream`）。
 *   依赖三个 @Global 模块的既有令牌，无需显式 imports：`TransportService`（事件面）、
 *   `QUEUE_SERVICE`（积压巡检）、`CACHE_STORE`（票据存储，redis 驱动下多实例共享）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/events
 */

import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

/**
 * SSE 实时推送模块
 */
@Module({
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}

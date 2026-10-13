/*
 * @file 传输演示模块（M8 T-M8-05 验收载体）
 * @description 装配三角色：提供方 EchoTransportHandler（@TransportHandler，启动扫描注册）、
 *   端口代理 ECHO_PORT（createEchoPort 工厂，与驱动无关）、演示控制器。
 *   传输能力自身由 app.module 的 TransportModule.forRoot 装配（全局模块），本模块只消费——
 *   与 cache-demo / demo-queue 的装配方式一致。
 * @author donttemo
 * @created 2026-10-14
 * @module example-api/demo-transport
 */

import { Module } from '@nestjs/common';
import { TRANSPORT_SERVICE } from '@fw/transport';
import { DemoTransportController } from './demo-transport.controller.js';
import { EchoTransportHandler } from './echo.handler.js';
import { ECHO_PORT, createEchoPort } from './echo.port.js';

/**
 * 传输演示模块
 */
@Module({
  controllers: [DemoTransportController],
  providers: [EchoTransportHandler, { provide: ECHO_PORT, useFactory: createEchoPort, inject: [TRANSPORT_SERVICE] }],
})
export class DemoTransportModule {}

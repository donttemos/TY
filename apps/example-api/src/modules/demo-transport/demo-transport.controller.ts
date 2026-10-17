/*
 * @file 传输演示端点（M8 T-M8-05 验收载体）
 * @description 暴露 /api/v1/demo-transport/* 供 scripts/smoke-transport.mjs 逐条验证 PRD-008 FR-06：
 *   in-process 直连、redis 单进程往返、redis 双进程跨进程调用（handledBy 证明由另一进程处理）、
 *   无处理方时超时 fail-fast、跨进程错误传播。与 cache-demo / demo-queue 一致整体标 @Public()：
 *   框架自检路由，不承载业务数据。
 * @author donttemo
 * @created 2026-10-14
 * @modified 2026-10-17 donttemo M12 W3（PRD-012 OBS-16）：演示自检端点默认非 dev 404（DemoEndpointsGuard）
 * @module example-api/demo-transport
 */

import { Body, Controller, Get, Inject, Post, UseGuards} from '@nestjs/common';
import { DemoEndpointsGuard } from '../../common/demo-endpoints.guard.js';
import { Public } from '@fw/auth';
import { BizError, ErrorCode } from '@fw/core';
import {
  HandlerNotRegisteredError,
  TRANSPORT_SERVICE,
  TransportError,
  TransportService,
  TransportTimeoutError,
  TransportUnavailableError,
} from '@fw/transport';
import { ECHO_PORT, type EchoPort, type EchoRequest, type EchoResponse } from './echo.port.js';

/** 回显响应 + 调用方实例标识（冒烟据此判定跨进程：handledBy ≠ callerId） */
export interface EchoCallResult extends EchoResponse {
  /** 调用方实例标识 */
  callerId: string;
}

/**
 * 传输演示控制器：路径前缀 /api/v1/demo-transport
 */
@Public()
@Controller('/api/v1/demo-transport')
@UseGuards(DemoEndpointsGuard)
export class DemoTransportController {
  /**
   * @param echo 回显端口（传输代理，与驱动无关）
   * @param transport 传输服务（统计与实例标识）
   */
  constructor(
    @Inject(ECHO_PORT) private readonly echoPort: EchoPort,
    @Inject(TRANSPORT_SERVICE) private readonly transport: TransportService,
  ) {}

  /** 经传输层调用提供方回显消息（驱动由 TRANSPORT_DRIVER 决定，调用方代码不变） */
  @Post('echo')
  async echo(@Body() body: EchoRequest): Promise<EchoCallResult> {
    try {
      const result = await this.echoPort.echo(body ?? { message: '' });
      return { ...result, callerId: this.transport.instanceId };
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  /** 传输统计快照（驱动 / 角色 / 注册地址 / 调用与处理计数） */
  @Get('stats')
  stats(): ReturnType<TransportService['stats']> {
    return this.transport.stats();
  }
}

/**
 * 传输错误到业务错误的映射：BizError 原样回传（跨进程按错误码重建，两种驱动 HTTP 语义一致），
 * 超时/未注册/驱动不可用归一到 9002/1002，其余传输错误归一 9001。
 * @param error 传输调用异常
 */
function mapTransportError(error: unknown): Error {
  if (error instanceof BizError) return error;
  if (error instanceof TransportTimeoutError) return new BizError(ErrorCode.DEPENDENCY_UNAVAILABLE, error.message);
  if (error instanceof HandlerNotRegisteredError) return new BizError(ErrorCode.NOT_FOUND, error.message);
  if (error instanceof TransportUnavailableError) return new BizError(ErrorCode.DEPENDENCY_UNAVAILABLE, error.message);
  if (error instanceof TransportError) return new BizError(ErrorCode.INTERNAL, error.message);
  return error instanceof Error ? error : new BizError(ErrorCode.INTERNAL, '传输调用失败');
}

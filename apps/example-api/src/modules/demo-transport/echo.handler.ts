/*
 * @file 传输演示的提供方（EchoTransportHandler）
 * @description 以 @TransportHandler('demo-transport.echo') 声明提供方；启动时由 TransportService
 *   扫描注册——in-process 驱动在本进程直接分发，redis 驱动经消费循环跨进程分发，处理器代码一致。
 *   空消息抛 BizError(1001)：冒烟据此验证跨进程错误传播（调用方收到同一错误码，catch 逻辑不变）。
 * @author donttemo
 * @created 2026-10-14
 * @module example-api/demo-transport
 */

import { Injectable } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { TransportHandler, type TransportContext } from '@fw/transport';
import type { EchoRequest, EchoResponse } from './echo.port.js';

/**
 * 回显处理器：传输地址 demo-transport.echo
 */
@TransportHandler('demo-transport.echo')
@Injectable()
export class EchoTransportHandler {
  /**
   * 处理回显请求
   * @param payload 调用载荷（EchoRequest）
   * @param ctx 传输上下文（携带处理方驱动与实例标识）
   * @returns 回显响应
   */
  async handle(payload: unknown, ctx: TransportContext): Promise<EchoResponse> {
    const request = payload as EchoRequest | undefined;
    const message = typeof request?.message === 'string' ? request.message.trim() : '';
    if (message.length === 0) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'message 不能为空');
    }
    return { message, driver: ctx.driver, handledBy: ctx.instanceId, receivedAt: ctx.receivedAt };
  }
}

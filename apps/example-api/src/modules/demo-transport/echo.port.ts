/*
 * @file 传输演示的业务契约（EchoPort）
 * @description M8 T-M8-05 验收载体：调用方（控制器）只依赖本接口，不关心提供方在本进程
 *   （in-process）还是另一个进程（redis）。接口即端口——换 transport 驱动时本文件与
 *   控制器代码零改动（PRD-008 FR-06 / TC-TNT-005）。
 * @author donttemo
 * @created 2026-10-14
 * @module example-api/demo-transport
 */

import { createTransportProxy, type TransportService } from '@fw/transport';

/** 回显请求 */
export interface EchoRequest {
  /** 待回显消息（不能为空；空消息由提供方抛 1001，用于验证跨进程错误传播） */
  message: string;
}

/** 回显响应（携带处理方信息，冒烟据此判定调用实际落在哪个进程） */
export interface EchoResponse {
  /** 回显消息 */
  message: string;
  /** 处理方驱动名 */
  driver: string;
  /** 处理方实例标识 */
  handledBy: string;
  /** 处理方收到请求的时刻（毫秒） */
  receivedAt: number;
}

/** 回显端口（业务侧唯一依赖） */
export interface EchoPort {
  /**
   * 回显一条消息
   * @param request 回显请求
   * @returns 回显响应（含处理方驱动与实例）
   */
  echo(request: EchoRequest): Promise<EchoResponse>;
}

/** 端口注入令牌 */
export const ECHO_PORT = Symbol('fw.demo.transport.echo');

/**
 * 创建回显端口的传输代理（模块装配用；in-process 与 redis 两种驱动下同一工厂代码）
 * @param transport 传输服务
 */
export function createEchoPort(transport: TransportService): EchoPort {
  return createTransportProxy<EchoPort>(transport, 'demo-transport');
}

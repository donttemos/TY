/*
 * @file in-process 传输驱动
 * @description 单体形态的传输驱动：调用在本进程内直接分发到本地处理器，不经网络。
 *   与 redis 驱动共用同一注册表与处理器契约，因此业务代码、端口接口与代理工厂完全一致，
 *   切换只改 TRANSPORT_DRIVER（PRD-008 FR-06 / TC-TNT-005）。
 *   caller 角色（TRANSPORT_ROLE=caller）下本进程按设计不处理请求，调用抛 HandlerNotRegisteredError。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { assertAddress, HandlerNotRegisteredError } from '../errors.js';
import type { TransportDriverPort } from '../driver.port.js';
import type { TransportRegistry } from '../registry.js';
import { withTimeout } from '../async.js';
import { withServerSpan } from '../trace.js';
import type { CallOptions, TransportContext, TransportHandlerFn } from '../types.js';

/** in-process 驱动构造选项 */
export interface InProcessDriverOptions {
  /** 实例标识（写入处理上下文，供对端诊断） */
  instanceId: string;
}

/**
 * in-process 传输驱动（单体，零外部依赖）
 */
export class InProcessTransportDriver implements TransportDriverPort {
  /** 驱动名 */
  readonly kind = 'in-process' as const;

  private handled = 0;

  /**
   * @param registry 处理器注册表（与服务共享）
   * @param options 实例标识
   */
  constructor(
    private readonly registry: TransportRegistry,
    private readonly options: InProcessDriverOptions,
  ) {}

  /**
   * 注册处理器
   * @param address 传输地址
   * @param handler 处理器
   */
  register(address: string, handler: TransportHandlerFn): void {
    this.registry.register(address, handler);
  }

  /** 启动：本进程直连，无外部依赖，无需启动动作 */
  async start(): Promise<void> {}

  /**
   * 发起调用（本地分发）
   * @param address 传输地址
   * @param payload 调用载荷
   * @param options 单次调用选项
   */
  async call<TRes = unknown>(address: string, payload: unknown, options?: CallOptions): Promise<TRes> {
    assertAddress(address);
    const handler = this.registry.handling ? this.registry.resolve(address) : undefined;
    if (!handler) throw new HandlerNotRegisteredError(address);
    const ctx: TransportContext = {
      address,
      driver: 'in-process',
      instanceId: this.options.instanceId,
      receivedAt: Date.now(),
    };
    this.handled += 1;
    // SERVER span：同进程直通，父上下文取当前活跃上下文（即调用方 CLIENT span），
    // 父子关系天然成立，无需信封过线。与 redis 驱动一致：超时窗口内执行（防本地处理器挂死拖住调用方）
    return (await withServerSpan(address, undefined, () =>
      withTimeout(() => handler(payload, ctx), options?.timeoutMs ?? 0, address),
    )) as TRes;
  }

  /** 可用性探测：本进程直连，恒可用 */
  async ping(): Promise<boolean> {
    return true;
  }

  /** 本进程已处理请求数 */
  handledCount(): number {
    return this.handled;
  }

  /** 优雅停机：无外部资源，无需动作 */
  async close(): Promise<void> {}
}

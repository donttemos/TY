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

import { Logger } from '@fw/logger';
import { assertAddress, assertTopic, HandlerNotRegisteredError } from '../errors.js';
import type { TransportDriverPort } from '../driver.port.js';
import type { TransportRegistry } from '../registry.js';
import { withTimeout } from '../async.js';
import { withServerSpan } from '../trace.js';
import type {
  CallOptions,
  TransportContext,
  TransportEventHandler,
  TransportEventMeta,
  TransportEventUnsubscribe,
  TransportHandlerFn,
  TransportTopic,
} from '../types.js';

const logger = Logger.for('transport');

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

  // ---------------- 事件面（M10 E-12：进程内扇出） ----------------

  /** 主题 → 订阅方集合（进程内，单实例形态） */
  private readonly eventHandlers = new Map<TransportTopic, Set<TransportEventHandler>>();

  /**
   * 发布事件：同步扇出到本进程订阅方，订阅方异常只记日志不中断其他订阅方
   *
   * 单实例形态下 SSE 连接与事件源同进程，因此无需 Redis 即可端到端推送；
   * 多副本请切 `TRANSPORT_DRIVER=redis`（命中跨实例扇出），业务代码不变。
   * @param topic 事件主题
   * @param payload 事件载荷（须可 JSON 序列化）
   */
  async publish(topic: TransportTopic, payload: unknown): Promise<void> {
    assertTopic(topic);
    const handlers = this.eventHandlers.get(topic);
    if (!handlers || handlers.size === 0) return;
    const meta: TransportEventMeta = {
      topic,
      driver: 'in-process',
      instanceId: this.options.instanceId,
      emittedAt: Date.now(),
    };
    for (const handler of [...handlers]) {
      try {
        handler(payload, meta);
      } catch (error) {
        logger.warn('in-process 事件订阅方抛出异常（已隔离，不影响其他订阅方）', {
          topic,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * 订阅事件
   * @param topic 事件主题
   * @param handler 处理器
   * @returns 取消订阅函数（幂等）
   */
  async subscribe(topic: TransportTopic, handler: TransportEventHandler): Promise<TransportEventUnsubscribe> {
    assertTopic(topic);
    const bucket = this.eventHandlers.get(topic) ?? new Set<TransportEventHandler>();
    bucket.add(handler);
    this.eventHandlers.set(topic, bucket);
    return () => {
      const current = this.eventHandlers.get(topic);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.eventHandlers.delete(topic);
    };
  }
}

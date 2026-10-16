/*
 * @file 传输服务（TransportService）
 * @description 业务侧唯一入口：注册处理器、发起调用、统计与就绪探测。启动时从 Nest 容器
 *   扫描 `@TransportHandler` 完成注册并启动驱动；停机时优雅关闭驱动。调用统一走
 *   `assertAddress` 校验与统计埋点，驱动差异（本进程直连 / Redis 往返）对业务透明——
 *   切换 TRANSPORT_DRIVER 时业务代码 diff = 0（PRD-008 FR-06 / TC-TNT-005）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { assertAddress, assertTopic, TransportEventsUnsupportedError, TransportTimeoutError } from './errors.js';
import { scanTransportHandlers } from './discovery.js';
import { withClientSpan } from './trace.js';
import { TRANSPORT_DRIVER, TRANSPORT_OPTIONS, TRANSPORT_REGISTRY } from './tokens.js';
import type { TransportDriverPort } from './driver.port.js';
import type { TransportRegistry } from './registry.js';
import type {
  CallOptions,
  TransportCallStats,
  TransportDriverName,
  TransportEventHandler,
  TransportEventMeta,
  TransportEventUnsubscribe,
  TransportHandlerFn,
  TransportTopic,
} from './types.js';

/**
 * 传输服务
 */
@Injectable()
export class TransportService {
  private readonly registry: TransportRegistry;
  private started = false;
  private calls = 0;
  private successes = 0;
  private failures = 0;
  private timeouts = 0;
  private eventsPublished = 0;
  private eventsReceived = 0;
  /** 主题 → 本进程订阅方数量（统计用；取消订阅后清理） */
  private readonly eventTopics = new Map<string, number>();

  /**
   * @param driver 传输驱动（按 TRANSPORT_DRIVER 装配）
   * @param registry 处理器注册表（与驱动共享）
   * @param options 运行时配置
   * @param discovery Nest 发现服务（装配期扫描；测试可缺省）
   * @param scanner 方法扫描器（预留；当前仅扫类级装饰器）
   */
  constructor(
    @Inject(TRANSPORT_DRIVER) private readonly driver: TransportDriverPort,
    @Inject(TRANSPORT_REGISTRY) registry: TransportRegistry,
    @Inject(TRANSPORT_OPTIONS) private readonly options: {
      instanceId: string;
      role: 'caller' | 'handler' | 'both';
      shutdownTimeoutMs: number;
    },
    @Optional() private readonly discovery?: DiscoveryService,
    @Optional() private readonly scanner?: MetadataScanner,
  ) {
    this.registry = registry;
  }

  /** 本进程实例标识 */
  get instanceId(): string {
    return this.options.instanceId;
  }

  /** 当前驱动名 */
  get driverKind(): TransportDriverName {
    return this.driver.kind;
  }

  /**
   * 注册处理器（扫描之外的手工注册入口）
   * @param address 传输地址
   * @param handler 处理器
   */
  register(address: string, handler: TransportHandlerFn): void {
    this.driver.register(address, handler);
  }

  /**
   * 发起一次传输调用
   * @param address 传输地址（点分，如 demo-transport.echo）
   * @param payload 调用载荷（须可 JSON 序列化）
   * @param options 单次调用选项（超时等）
   * @returns 对端结果
   */
  async call<TRes = unknown>(address: string, payload: unknown, options?: CallOptions): Promise<TRes> {
    assertAddress(address);
    this.calls += 1;
    try {
      // CLIENT span 包裹整次调用：该 span 期间发起的传输操作共享同一 traceId
      // （未启用追踪时为非记录 span，零开销）
      const result = await withClientSpan(address, this.driver.kind, () =>
        this.driver.call<TRes>(address, payload, options),
      );
      this.successes += 1;
      return result;
    } catch (error) {
      this.failures += 1;
      if (error instanceof TransportTimeoutError) this.timeouts += 1;
      throw error;
    }
  }

  /** 可用性探测（就绪探针用） */
  async ping(): Promise<boolean> {
    return await this.driver.ping();
  }

  // ---------------- 事件面（M10 E-12） ----------------

  /**
   * 发布事件
   *
   * 驱动未实现事件面时抛 `TransportEventsUnsupportedError`（快速失败优于静默丢事件——
   * 静默会让 SSE 页面永远收不到推送却无任何报错）。
   * @param topic 事件主题（点分，如 job.progress）
   * @param payload 事件载荷（须可 JSON 序列化）
   */
  async publish(topic: TransportTopic, payload: unknown): Promise<void> {
    assertTopic(topic);
    const publish = this.driver.publish?.bind(this.driver);
    if (!publish) throw new TransportEventsUnsupportedError(this.driver.kind);
    await publish(topic, payload);
    this.eventsPublished += 1;
  }

  /**
   * 订阅事件
   *
   * 本服务在订阅方之上再包一层：计数 + 保护调用方（驱动已隔离订阅方异常，此处只做统计）。
   * @param topic 事件主题
   * @param handler 处理器
   * @returns 取消订阅函数（幂等；同步释放主题计数）
   */
  async subscribe(topic: TransportTopic, handler: TransportEventHandler): Promise<TransportEventUnsubscribe> {
    assertTopic(topic);
    const subscribe = this.driver.subscribe?.bind(this.driver);
    if (!subscribe) throw new TransportEventsUnsupportedError(this.driver.kind);
    const wrapped: TransportEventHandler = (payload: unknown, meta: TransportEventMeta) => {
      this.eventsReceived += 1;
      handler(payload, meta);
    };
    const unsubscribe = await subscribe(topic, wrapped);
    this.eventTopics.set(topic, (this.eventTopics.get(topic) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.eventTopics.get(topic) ?? 1) - 1;
      if (next <= 0) this.eventTopics.delete(topic);
      else this.eventTopics.set(topic, next);
      unsubscribe();
    };
  }

  /** 调用统计快照 */
  stats(): TransportCallStats {
    return {
      driver: this.driver.kind,
      instanceId: this.options.instanceId,
      role: this.options.role,
      addresses: this.registry.size,
      addressList: this.registry.addresses(),
      calls: this.calls,
      successes: this.successes,
      failures: this.failures,
      timeouts: this.timeouts,
      handled: this.driver.handledCount(),
      events: {
        published: this.eventsPublished,
        received: this.eventsReceived,
        topics: this.eventTopics.size,
        topicList: [...this.eventTopics.keys()],
      },
      started: this.started,
    };
  }

  /** 应用启动：扫描注册处理器 → 启动驱动 */
  async onApplicationBootstrap(): Promise<void> {
    if (this.discovery) {
      for (const scanned of scanTransportHandlers(this.discovery.getProviders())) {
        this.register(scanned.address, (payload, ctx) => boundHandle(scanned.instance, payload, ctx));
      }
    }
    await this.driver.start();
    this.started = true;
  }

  /** 应用停机：优雅关闭驱动（停在途请求在超时内完成） */
  async onApplicationShutdown(): Promise<void> {
    await this.driver.close(this.options.shutdownTimeoutMs);
    this.started = false;
  }
}

/** 调用实例上的 handle（保持 this 绑定） */
function boundHandle(instance: object, payload: unknown, ctx: unknown): Promise<unknown> | unknown {
  return (instance as { handle: (payload: unknown, ctx: unknown) => Promise<unknown> | unknown }).handle(payload, ctx);
}

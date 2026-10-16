/*
 * @file 传输驱动端口（TransportDriverPort）
 * @description 框架自有的微服务调用语义抽象：地址注册、启动、发起调用、可用性探测与优雅停机。
 *   in-process 与 redis 两种驱动实现同一端口，TransportService 只依赖本端口，因此切换驱动时
 *   业务代码与服务层 diff = 0（PRD-008 FR-06 / TC-TNT-005）。
 *   M10 E-12 起端口额外承载**事件面**（publish/subscribe，可选能力）——RPC 面是「找谁处理」，
 *   事件面是「发生了什么」；两者共用同一驱动与生命周期，SSE 实时推送据此多副本免粘滞。
 *   本文件不得出现任何驱动特有类型（ioredis 等）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import type {
  CallOptions,
  TransportDriverName,
  TransportEventHandler,
  TransportEventUnsubscribe,
  TransportHandlerFn,
  TransportTopic,
} from './types.js';

/**
 * 传输驱动端口
 *
 * 语义约定：
 * - `register(address, handler)` 注册处理器；重复地址抛 `DuplicateAddressError`；
 *   redis 驱动在启动后收到注册会即时补起该地址的消费循环；
 * - `start()` 启动驱动：in-process 无外部依赖无需动作；redis 按角色起消费循环
 *   （caller 角色只发起调用，不消费请求）；
 * - `call()` 发起一次调用：载荷须可 JSON 序列化；超时抛 `TransportTimeoutError`；
 * - `close()` 停止消费 → 等在途请求（超时上限由入参给出）→ 断开连接。
 */
export interface TransportDriverPort {
  /** 驱动名 */
  readonly kind: TransportDriverName;

  /**
   * 注册处理器
   * @param address 传输地址（点分，如 demo-transport.echo）
   * @param handler 处理器
   */
  register(address: string, handler: TransportHandlerFn): void;

  /** 启动驱动（注册完成后调用；重复调用幂等） */
  start(): Promise<void>;

  /**
   * 发起调用
   * @param address 传输地址
   * @param payload 调用载荷（须可 JSON 序列化）
   * @param options 单次调用选项（超时等）
   * @returns 对端结果
   */
  call<TRes = unknown>(address: string, payload: unknown, options?: CallOptions): Promise<TRes>;

  /** 可用性探测（就绪探针用） */
  ping(): Promise<boolean>;

  /** 本进程已处理请求数（诊断与统计用） */
  handledCount(): number;

  /**
   * 优雅停机：停止消费 → 等待在途请求（超时）→ 断开连接
   * @param timeoutMs 等待上限（毫秒）
   */
  close(timeoutMs?: number): Promise<void>;

  // ---------------- 事件面（可选能力，M10 E-12） ----------------

  /**
   * 发布事件（扇出，无应答）
   *
   * 语义约定：in-process 驱动在本进程内向订阅方扇出（单体形态）；redis 驱动经
   * `PUBLISH <prefix>:evt:<topic>` 广播，**其他实例的订阅方也能收到**（多副本形态）。
   * 发布方不关心是否有订阅方，无订阅方时为无害空操作。RPC 面（call）与事件面互不影响。
   *
   * 未实现该能力的驱动（如预留的 tcp / kafka 或测试注入的 RPC-only 桩）不提供本方法，
   * 由 `TransportService.publish` 统一转 `TransportEventsUnsupportedError`。
   *
   * @param topic 事件主题（点分，如 job.progress）
   * @param payload 事件载荷（须可 JSON 序列化）
   */
  publish?(topic: TransportTopic, payload: unknown): Promise<void>;

  /**
   * 订阅事件
   *
   * 同一主题可多订阅方；处理器抛出的异常由驱动吞掉并记日志（单个 SSE 连接断开不影响其他）。
   * 返回取消订阅函数（幂等）。redis 驱动在最后一个订阅方取消后 UNSUBSCRIBE 该频道。
   *
   * @param topic 事件主题
   * @param handler 处理器
   * @returns 取消订阅函数
   */
  subscribe?(topic: TransportTopic, handler: TransportEventHandler): Promise<TransportEventUnsubscribe>;
}

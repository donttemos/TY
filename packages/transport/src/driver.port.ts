/*
 * @file 传输驱动端口（TransportDriverPort）
 * @description 框架自有的微服务调用语义抽象：地址注册、启动、发起调用、可用性探测与优雅停机。
 *   in-process 与 redis 两种驱动实现同一端口，TransportService 只依赖本端口，因此切换驱动时
 *   业务代码与服务层 diff = 0（PRD-008 FR-06 / TC-TNT-005）。
 *   本文件不得出现任何驱动特有类型（ioredis 等）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import type { CallOptions, TransportDriverName, TransportHandlerFn } from './types.js';

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
}

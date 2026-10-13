/*
 * @file 处理器注册表
 * @description 传输地址到处理器的映射，由驱动与 TransportService 共享同一实例。
 *   `handling` 由 TRANSPORT_ROLE 决定（handler / both 为 true）：in-process 驱动据此判断
 *   本进程是否本地解析，redis 驱动据此判断是否起消费循环——caller 角色的进程按设计不处理请求。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { assertAddress, DuplicateAddressError } from './errors.js';
import type { TransportHandlerFn, TransportRole } from './types.js';

/** 角色是否包含处理方职责 */
export function roleIncludesHandler(role: TransportRole): boolean {
  return role === 'handler' || role === 'both';
}

/**
 * 传输处理器注册表
 */
export class TransportRegistry {
  private readonly handlers = new Map<string, TransportHandlerFn>();

  /** 本进程是否承担处理方职责（由 TRANSPORT_ROLE 决定） */
  readonly handling: boolean;

  /**
   * @param role 本进程传输角色
   */
  constructor(role: TransportRole) {
    this.handling = roleIncludesHandler(role);
  }

  /**
   * 注册处理器（重复地址抛 DuplicateAddressError）
   * @param address 传输地址
   * @param handler 处理器
   */
  register(address: string, handler: TransportHandlerFn): void {
    assertAddress(address);
    if (this.handlers.has(address)) throw new DuplicateAddressError(address);
    this.handlers.set(address, handler);
  }

  /**
   * 解析处理器
   * @param address 传输地址
   * @returns 处理器或 undefined
   */
  resolve(address: string): TransportHandlerFn | undefined {
    return this.handlers.get(address);
  }

  /**
   * 是否已注册某地址
   * @param address 传输地址
   */
  has(address: string): boolean {
    return this.handlers.has(address);
  }

  /** 已注册地址列表（注册顺序） */
  addresses(): string[] {
    return [...this.handlers.keys()];
  }

  /** 已注册地址数 */
  get size(): number {
    return this.handlers.size;
  }
}

/*
 * @file 装饰器：@TransportHandler
 * @description 声明式注册入口（PRD-008 FR-06）：`@TransportHandler('demo-transport.echo')`
 *   标注在实现类上，类须提供 `handle(payload, ctx)` 方法；应用启动时由 TransportService
 *   扫描容器自动注册，业务无需手写注册代码。元数据键由本文件导出，供扫描器读取。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import 'reflect-metadata';

/** 处理器元数据键 */
export const META_TRANSPORT_HANDLER = 'fw:transport:handler';

/**
 * 声明传输处理器（标注在实现类上）
 * @param address 传输地址（点分，如 demo-transport.echo）
 * @returns 类装饰器
 * @example
 * ```ts
 * @TransportHandler('demo-transport.echo')
 * @Injectable()
 * export class EchoHandler {
 *   async handle(payload: { message: string }, ctx: TransportContext): Promise<unknown> { ... }
 * }
 * ```
 */
export function TransportHandler(address: string): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(META_TRANSPORT_HANDLER, address, target);
  };
}

/**
 * 读取类上的传输地址
 * @param target 类或实例
 */
export function readTransportHandlerAddress(target: object): string | undefined {
  return Reflect.getMetadata(META_TRANSPORT_HANDLER, target) as string | undefined;
}

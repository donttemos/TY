/*
 * @file 客户端代理：把端口接口的调用翻译成传输调用
 * @description 业务模块只依赖自己的端口接口（如 EchoPort），模块经 useFactory 注入
 *   `createTransportProxy(transport, '<地址前缀>')` 得到实现：代理对象的每个方法都映射为
 *   一次 `<地址前缀>.<方法名>` 传输调用。代理与驱动无关——换 transport 驱动时这段工厂代码
 *   与调用方代码都不变（PRD-008 FR-06 / TC-TNT-005）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import type { TransportService } from './transport.service.js';

/**
 * 代理对象上不映射为传输调用的属性：
 * - 序列化/展开陷阱（then/toJSON 等，被 await 或 JSON.stringify 触碰）；
 * - Nest 生命周期钩子名（框架按「方法存在即调用」逐个 invoke provider，
 *   误映射会产生 `<前缀>.onModuleInit` 这类幽灵调用）。
 * 端口接口的方法应为领域动词（echo/stats 等），不会与上述名字冲突。
 * 注意：`constructor` 不走黑名单——它必须返回函数以维持对象契约
 * （@fw/queue 等扫描器会读 `instance.constructor` 并交给 Reflect.getMetadata，
 *  返回 undefined 会直接抛 TypeError），故以无元数据的哑构造器承接。
 */
const NON_METHOD_PROPS = new Set([
  'then',
  'catch',
  'finally',
  'toJSON',
  'toString',
  'valueOf',
  'inspect',
  'nodeType',
  'tagName',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
  'configure',
]);

/** 哑构造器：满足对象契约，不携带任何装饰器元数据（扫描器读不到即跳过） */
const PROXY_CONSTRUCTOR = function TransportPortProxy(): void {
  /* 代理对象不可 new */
};

/**
 * 创建端口接口的传输代理
 * @param transport 传输服务
 * @param addressPrefix 地址前缀（点分，如 demo-transport）；方法名追加为最后一段
 * @returns 实现端口接口 T 的代理对象
 * @example
 * ```ts
 * { provide: ECHO_PORT, useFactory: (t: TransportService) => createTransportProxy<EchoPort>(t, 'demo-transport'), inject: [TRANSPORT_SERVICE] }
 * ```
 */
export function createTransportProxy<T>(transport: TransportService, addressPrefix: string): T {
  const target = {} as T;
  return new Proxy(target as object, {
    get(_target, prop) {
      if (prop === 'constructor') return PROXY_CONSTRUCTOR;
      if (typeof prop !== 'string' || NON_METHOD_PROPS.has(prop)) return undefined;
      return (payload: unknown) => transport.call(`${addressPrefix}.${prop}`, payload);
    },
  }) as T;
}

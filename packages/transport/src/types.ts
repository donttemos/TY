/*
 * @file 传输层公共类型
 * @description @fw/transport 的驱动名、运行时配置、调用上下文、消息信封与应答结构。
 *   业务模块经接口（端口）相互调用：传输驱动决定调用在本进程直接完成（in-process，单体）
 *   还是经 Redis 往返（redis，跨进程/微服务）；tcp / kafka 为预留驱动（M8 未落地，配置枚举不开放）。
 *   本文件不得出现任何驱动特有类型（ioredis 等）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

/** 传输驱动名（M8 提供 in-process / redis；tcp / kafka 仅预留） */
export type TransportDriverName = 'in-process' | 'redis' | 'tcp' | 'kafka';

/** 本进程在传输拓扑中的角色：caller 只发起调用；handler 只处理请求；both 两者兼顾（默认） */
export type TransportRole = 'caller' | 'handler' | 'both';

/** 单次调用选项 */
export interface CallOptions {
  /** 超时（毫秒），缺省取运行时配置 TRANSPORT_TIMEOUT_MS */
  timeoutMs?: number;
}

/** 处理器执行上下文（由驱动在分发时构造，跨进程时携带处理方信息） */
export interface TransportContext {
  /** 传输地址 */
  address: string;
  /** 处理方驱动名 */
  driver: TransportDriverName;
  /** 处理方实例标识（缺省 `主机名-pid`） */
  instanceId: string;
  /** 处理方收到请求的时刻（毫秒） */
  receivedAt: number;
}

/** 传输处理器：同步或异步返回结果；抛出异常即视为失败并回传调用方（与类装饰器 @TransportHandler 同名不同物，故加 Fn 后缀） */
export type TransportHandlerFn = (payload: unknown, ctx: TransportContext) => Promise<unknown> | unknown;

/** 请求信封（redis 驱动经 JSON 序列化后过线） */
export interface TransportEnvelope {
  /** 关联 ID（调用方生成，用于匹配应答） */
  id: string;
  /** 传输地址 */
  address: string;
  /** 调用载荷（须可 JSON 序列化） */
  payload: unknown;
  /** 应答列表键 */
  replyTo: string;
  /** 调用方实例标识 */
  callerId: string;
  /** 发起时刻（毫秒） */
  sentAt: number;
  /** 调用方超时（毫秒）；处理方同步作为执行上限 */
  timeoutMs: number;
}

/** 序列化后的错误（跨进程回传） */
export interface TransportErrorPayload {
  /** 错误名 */
  name: string;
  /** 错误消息 */
  message: string;
  /** 业务错误码（BizError 携带；用于调用方按原类型重建） */
  code?: number;
  /** 字段级错误（BizError 携带时透传） */
  details?: Array<{ field: string; message: string }>;
}

/** 应答信封 */
export interface TransportReply {
  /** 关联 ID（与请求一致） */
  id: string;
  /** 是否成功 */
  ok: boolean;
  /** 成功结果 */
  result?: unknown;
  /** 失败错误（序列化形态） */
  error?: TransportErrorPayload;
}

/** 运行时配置（由 TRANSPORT_* 环境变量构建） */
export interface TransportRuntimeOptions {
  /** 驱动名 */
  driver: TransportDriverName;
  /** Redis 连接串（redis 驱动必填；缺省回退 CACHE_URL） */
  url?: string;
  /** key 前缀（留空自动取 `fw:<APP_ENV>`） */
  prefix: string;
  /** 单次调用默认超时（毫秒） */
  timeoutMs: number;
  /** 本进程角色 */
  role: TransportRole;
  /** 实例标识 */
  instanceId: string;
  /** 优雅停机等待在途请求的超时（毫秒） */
  shutdownTimeoutMs: number;
}

/** 调用统计快照 */
export interface TransportCallStats {
  /** 驱动名 */
  driver: TransportDriverName;
  /** 实例标识 */
  instanceId: string;
  /** 本进程角色 */
  role: TransportRole;
  /** 已注册地址数 */
  addresses: number;
  /** 已注册地址列表 */
  addressList: string[];
  /** 发起调用总数 */
  calls: number;
  /** 成功数 */
  successes: number;
  /** 失败数（含超时） */
  failures: number;
  /** 其中超时数 */
  timeouts: number;
  /** 本进程处理请求数 */
  handled: number;
  /** 是否已启动 */
  started: boolean;
}

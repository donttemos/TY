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
  /**
   * W3C traceparent 头（M8 T-M8-06 链路追踪）：调用方发起时的活跃上下文序列化，
   * 处理方据此提取父上下文续接同一 traceId（TC-TNT-006 跨服务链路）。
   * 未启用追踪或注入了空载体时缺省；处理方按根 span 处理。
   */
  traceparent?: string;
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

// ---------------- 事件面（M10 E-12：SSE 实时推送的承载通道） ----------------

/**
 * 事件主题：点分非空段（如 `job.progress` / `queue.alert`）。
 * 与传输地址（RPC 面）分属两个命名空间——地址是「找谁处理」，主题是「发生了什么」。
 */
export type TransportTopic = string;

/** 事件元信息（驱动在投递时构造，供订阅方诊断与去重） */
export interface TransportEventMeta {
  /** 主题 */
  topic: TransportTopic;
  /** 发布方驱动名 */
  driver: TransportDriverName;
  /** 发布方实例标识（缺省 `主机名-pid`） */
  instanceId: string;
  /** 发布时刻（毫秒时间戳） */
  emittedAt: number;
}

/**
 * 事件处理器：与 RPC 处理器（`TransportHandlerFn`）的区别在于**无返回值**且**扇出**——
 * 同一主题的全部订阅方都会收到（RPC 是一对一应答）。异常被驱动吞掉并记日志，
 * 单个订阅方故障不影响其他订阅方（SSE 单连接断开的典型场景）。
 */
export type TransportEventHandler = (payload: unknown, meta: TransportEventMeta) => void;

/** 取消订阅函数（幂等；重复调用无副作用） */
export type TransportEventUnsubscribe = () => void;

/** 事件发布统计（并入 TransportCallStats.events） */
export interface TransportEventStats {
  /** 本进程已发布事件数 */
  published: number;
  /** 本进程已收到事件数（含跨进程经 Redis 扇出到达的） */
  received: number;
  /** 当前订阅的主题数 */
  topics: number;
  /** 当前订阅的主题列表 */
  topicList: string[];
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
  /** 事件面统计（发布 / 接收 / 订阅主题） */
  events: TransportEventStats;
  /** 是否已启动 */
  started: boolean;
}

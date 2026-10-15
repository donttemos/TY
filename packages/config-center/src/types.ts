/*
 * @file 配置中心类型与端口
 * @description PRD-009 FR-01：ConfigCenterDriverPort（事实源适配，首版 file；nacos 预留注册位）与
 *   ConfigAuditPort（审计端口反转——框架不反向依赖 @fw/auth，由应用装配桥接，先例 DataScopeOrgPort）。
 * @author donttemo
 * @created 2026-10-15
 * @module config-center
 */

/** 配置变更来源：api = 管理端点直写；file = 事实源文件被外部修改（轮询发现） */
export type ConfigChangeSource = 'api' | 'file';

/** 写入上下文（单一生效管道的调用方信息） */
export interface ConfigWriteContext {
  /** 变更来源 */
  source: ConfigChangeSource;
  /** 操作者：用户名（api 源）或 `system`（file 源） */
  operator: string;
  /** 操作者用户 ID（api 源携带，file 源为空；供审计 userId 关联） */
  operatorId?: string | null;
}

/** 单条配置变更记录（审计与通知共用的事实描述） */
export interface ConfigChangeRecord {
  /** 配置键（点路径，如 log.level） */
  key: string;
  /** 变更前值（恢复 env 默认时为 env 快照值） */
  oldValue: unknown;
  /** 变更后值 */
  newValue: unknown;
  /** 变更来源 */
  source: ConfigChangeSource;
  /** 操作者（用户名或 system） */
  operator: string;
  /** 操作者用户 ID（api 源携带；file 源为 null——审计 userId 关联用） */
  operatorId?: string | null;
  /** 是否成功生效（false = 被拒绝：白名单外 / 值非法 / 持久化失败） */
  ok: boolean;
  /** 拒绝原因（ok=false 时携带，写入审计 after 供「为什么被拒」排障） */
  reason?: string;
  /** 请求 traceId（file 轮询入口无请求上下文时为 null） */
  traceId: string | null;
  /** 变更时间（ISO 串） */
  at: string;
}

/**
 * 审计端口（端口反转）：框架包不依赖 @fw/auth。
 * 实现方**必须同步等待落盘**（如 AuditService.recordSync）——抛错即视为审计失败，
 * 管道将整体失败且不应用变更（先审计后生效，PRD-009 FR-05）。
 */
export interface ConfigAuditPort {
  /**
   * 记录一条配置变更审计
   * @param change 变更事实
   * @throws 落盘失败时抛错（成功变更将整体失败回滚；失败变更的审计错误仅记日志）
   */
  recordChange(change: ConfigChangeRecord): Promise<void>;
}

/**
 * 配置事实源驱动端口（PRD-009 FR-01 adapter 注册位）
 *
 * 语义约定：
 * - 驱动是「运行时覆盖值」的**唯一持久化位置**（file 适配 → runtime.json；与 Nacos 配置模型同构）；
 * - `load()` 只做读取与解析，**不做键/值校验**（校验是管道职责）；文件缺失或损坏返回 null，
 *   由 ConfigCenterService 决定 fail-open（WARN + 空快照）语义；
 * - `write()` 必须原子落盘（临时文件 + rename），失败时保持旧文件不变；
 * - `watch()` 订阅外部变更（file 适配 = mtime 轮询）：读取/解析失败由驱动自行记日志并跳过本轮，
 *   只在**解析出有效快照**时回调；停机用 `stop()` 释放定时器等资源。
 */
export interface ConfigDriverPort {
  /** 驱动名（file / 预留 nacos） */
  readonly kind: string;
  /** 轮询间隔（秒）；仅轮询型驱动提供，用于诊断展示 */
  readonly pollSeconds?: number | null;
  /**
   * 全量读取运行时覆盖快照
   * @returns 点路径 → 覆盖值；文件缺失或损坏返回 null（fail-open 由上层决定）
   */
  load(): Promise<Record<string, unknown> | null>;
  /**
   * 原子写入全量运行时覆盖快照
   * @param snapshot 点路径 → 覆盖值（空对象 = 清空全部覆盖）
   */
  write(snapshot: Record<string, unknown>): Promise<void>;
  /**
   * 订阅外部变更；回调入参为**外部事实源当前完整快照**（内部写入不回调——驱动必须抑制自触发）
   * @param onChange 外部快照回调
   */
  watch(onChange: (snapshot: Record<string, unknown>) => void): void;
  /** 释放驱动资源（轮询定时器 / 连接） */
  stop(): Promise<void>;
}

/** 单个配置键的视图（GET /configs 列表项） */
export interface ConfigEntryView {
  /** 点路径 */
  key: string;
  /** 当前生效值（运行时覆盖优先于 env 快照） */
  value: unknown;
  /** 生效来源：runtime = 被运行时覆盖；env = 仍取 env 快照 */
  source: 'runtime' | 'env';
  /** 是否可热更新（白名单内恒为 true——本列表只列白名单键） */
  hot: true;
  /** 对应 Env 键名（LOG_LEVEL 等，诊断用） */
  envKey: string;
  /** 最近一次生效时间（ISO 串；env 来源且从未被覆盖时为 null） */
  updatedAt: string | null;
}

/** 配置中心运行元信息（诊断用，不阻塞就绪判定） */
export interface ConfigCenterMeta {
  /** 驱动名 */
  driver: string;
  /** 快照版本号：每次成功应用（含启动 load 与运行时变更）单调递增 */
  snapshotVersion: number;
  /** mtime 轮询间隔（秒；非轮询驱动为 null） */
  pollSeconds: number | null;
  /** 最近一次成功应用变更时间（ISO 串；启动后无变更为 null） */
  lastAppliedAt: string | null;
  /** 最近一次错误摘要（最近 1 条；无错误为 null）——排障入口，详见结构化日志 */
  lastError: string | null;
}

/** 写入结果 */
export interface ConfigWriteResult {
  /** 点路径 */
  key: string;
  /** 旧值 */
  oldValue: unknown;
  /** 新值（已生效） */
  newValue: unknown;
  /** 快照版本号（本次变更后的） */
  snapshotVersion: number;
}

/** 订阅退订函数 */
export type Unsubscribe = () => void;

/*
 * @file 配置中心服务（单一生效管道）
 * @description PRD-009 FR-04/FR-05：所有变更（API 直写与文件轮询两条入口）都经过同一条管道——
 *   键检查 → zod 校验 → 审计（先审计后生效，审计失败整体失败）→ 应用覆盖 → 通知订阅者 → 持久化（仅 API 源）。
 *   白名单从 @fw/config 的 ENV_HOT_KEYS 派生（fail-safe：未登记即不可热更）；非法值拒绝时旧值保持并记失败审计。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-15 donttemo M9 Backlog：一键回滚——进程内快照历史环形表（20 条）+ rollback()
 *   （先全量预审计 → 持久化目标覆盖 → 逐键应用并通知；回滚本身也是一次版本推进并计入历史）
 * @modified 2026-10-15 donttemo M10 E-02：多实例语义——可选注入 ConfigHistoryPort，快照历史下沉
 *   持久层：版本号以持久层最新值为基线推进（多实例不撞号），回滚候选集跨实例可见（AC2），
 *   syncRemoteVersion() 供 GET /configs 读取时对齐（A 写版本 B 读一致）。不注入 = 进程内环形表（原行为）
 * @modified 2026-10-15 donttemo M10/E-16：快照历史保留版本数经 maxHistory 选项配置
 *   （CONFIG_CENTER_HISTORY_MAX，默认 20；进程内环形表与持久历史淘汰窗口同口径）
 * @module config-center
 */
import { envSchema, ENV_HOT_KEYS, ENV_KEY_PATHS, type Env } from '@fw/config';
import { BizError, ErrorCode } from '@fw/core';
import { Logger, getTraceId } from '@fw/logger';
import type {
  ConfigAuditPort,
  ConfigCenterMeta,
  ConfigDriverPort,
  ConfigEntryView,
  ConfigHistoryPort,
  ConfigRollbackChange,
  ConfigRollbackResult,
  ConfigSnapshotEntry,
  ConfigWriteContext,
  ConfigWriteResult,
  Unsubscribe,
} from './types.js';

const logger = Logger.for('config.center');

/** 快照历史保留上限默认值（进程内环形；超出淘汰最旧，回滚到已淘汰版本报 5003。M10/E-16 起可配置） */
const DEFAULT_MAX_HISTORY = 20;

/** 点路径 → Env 键名（热更新白名单倒排） */
const HOT_PATH_TO_ENV: ReadonlyMap<string, string> = new Map(Object.entries(ENV_HOT_KEYS).map(([path, envKey]) => [path, envKey]));

/** 全部合法点路径集合（5001 与 5003 的分界：已知但不可热更 vs 完全未知） */
const KNOWN_PATHS: ReadonlySet<string> = new Set(Object.values(ENV_KEY_PATHS));

/** 热更新白名单键数（列表与诊断用） */
const HOT_PATHS: readonly string[] = Object.keys(ENV_HOT_KEYS);

/** 构造参数 */
export interface ConfigCenterOptions {
  /** 事实源驱动（file = 本地文件；nacos = Nacos v1 Open API 轮询，M10 E-02 转正入枚举） */
  driver: ConfigDriverPort;
  /** 启动时已校验的 env 快照（覆盖值的回退基线） */
  env: Env;
  /** 审计端口（缺省无审计——仅建议测试场景；生产装配必须提供） */
  audit?: ConfigAuditPort;
  /**
   * 快照历史持久端口（M10 E-02 多实例语义，可选）：注入后历史与版本基线下沉持久层，
   * 多副本回滚/版本号一致；缺省 = 进程内环形表（M9 原行为，单实例语义）
   */
  history?: ConfigHistoryPort;
  /**
   * 快照历史保留版本数（M10/E-16，CONFIG_CENTER_HISTORY_MAX）：进程内环形表与持久历史
   * 淘汰窗口同口径；缺省 20
   */
  maxHistory?: number;
  /** 时钟注入（测试用；缺省系统时间） */
  now?: () => Date;
}

/** 递归相等（配置值为 JSON 语义：标量 / 数组 / 普通对象） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  // 数组与普通对象统一走有序 JSON 比较——配置对象无键序敏感场景
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 配置中心服务：白名单热更 + 单一生效管道 + 事实源持久化
 *
 * 生命周期：`init()`（启动加载与全量校验，非法条目 fail-fast）→ 运行期 `write()` / 轮询 → `shutdown()`。
 */
export class ConfigCenterService {
  private readonly driver: ConfigDriverPort;

  /** 启动 env 快照（恢复默认值的回退基线） */
  private readonly env: Env;

  private readonly audit: ConfigAuditPort | undefined;

  /** 快照历史持久端口（M10 E-02，可选；缺省进程内环形表） */
  private readonly historyPort: ConfigHistoryPort | undefined;

  /** 快照历史保留版本数（M10/E-16，CONFIG_CENTER_HISTORY_MAX；环形表与持久淘汰窗口同口径） */
  private readonly maxHistory: number;

  private readonly now: () => Date;

  /** 运行时覆盖（点路径 → 覆盖值）；与事实源文件保持镜像 */
  private readonly overlay = new Map<string, unknown>();

  /** 各键最近生效时间（ISO 串） */
  private readonly updatedAt = new Map<string, string>();

  /** 订阅表（点路径 → 回调集合）；订阅者异常只记日志，不影响其他订阅者 */
  private readonly subscribers = new Map<string, Set<(value: unknown, key: string) => void>>();

  /** 快照版本号：每次成功应用（含启动 load）单调递增 */
  private version = 0;

  private lastAppliedAt: string | null = null;

  private lastError: string | null = null;

  /** 防止并发轮询 diff 与 API 写交错时重复应用同一键（进程内串行即可） */
  private applying = false;

  /** 快照历史（环形，按 version 升序追加；回滚数据源） */
  private readonly history: ConfigSnapshotEntry[] = [];

  constructor(options: ConfigCenterOptions) {
    this.driver = options.driver;
    this.env = options.env;
    this.audit = options.audit;
    this.historyPort = options.history;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.now = options.now ?? (() => new Date());
  }

  /** 快照版本号（诊断用） */
  get snapshotVersion(): number {
    return this.version;
  }

  /**
   * 启动加载：读事实源 → 全量校验（非法条目 fail-fast，与 env 非法值启动即失败同语义）→ 应用覆盖。
   * 文件缺失 / 损坏 → fail-open：WARN + 按 env 快照启动（PRD-009 NFR）。
   * 启动期不做审计、不逐键通知（订阅者尚未注册，初始值由装配方按 env 直接配置）。
   */
  async init(): Promise<void> {
    const raw = await this.driver.load();
    if (raw === null) {
      this.lastError = '配置事实源缺失或损坏，按 env 快照启动（fail-open）';
      logger.warn('配置中心：事实源不可读，按 env 快照启动（fail-open）', { driver: this.driver.kind });
      this.version = 1;
      await this.recordHistory();
      return;
    }
    // 全量校验：键与值任一非法即启动失败
    for (const [key, value] of Object.entries(raw)) {
      const envKey = HOT_PATH_TO_ENV.get(key);
      if (!envKey) {
        throw new BizError(
          KNOWN_PATHS.has(key) ? ErrorCode.CONFIG_NOT_HOT : ErrorCode.CONFIG_NOT_FOUND,
          `配置事实源含非法键「${key}」：${KNOWN_PATHS.has(key) ? '该键不可热更新' : '未知配置键'}`,
        );
      }
      this.assertValueValid(envKey, key, value);
    }
    for (const [key, value] of Object.entries(raw)) {
      this.overlay.set(key, value);
      this.updatedAt.set(key, this.now().toISOString());
    }
    this.version = 1;
    // M10 E-02：持久历史下启动版本基线对齐远端（其他实例已推进的版本不从 1 重启计数）
    if (this.historyPort) {
      try {
        const remote = await this.historyPort.latest();
        this.version = Math.max(this.version, remote?.version ?? 1);
      } catch (error) {
        logger.warn('配置中心：启动读取持久历史失败（按本地版本号启动）', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.recordHistory();
    // 启动轮询：外部事实源变更 → ingestExternal（file 适配 = mtime 轮询回调；单实例语义，文档已明示）
    this.driver.watch((snapshot) => {
      void this.ingestExternal(snapshot).catch((error: unknown) => {
        logger.error('配置中心：外部事实源消费异常（本轮丢弃）', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    logger.info('配置中心已加载运行时覆盖', {
      driver: this.driver.kind,
      keys: Object.keys(raw).length,
      snapshotVersion: this.version,
    });
  }

  /** 释放驱动资源（轮询定时器等） */
  async shutdown(): Promise<void> {
    await this.driver.stop();
  }

  /**
   * 订阅某键的生效变更（PRD-009 FR-09：框架服务经此订阅，禁止自行轮询）
   * @param key 点路径（必须在白名单内，未登记键直接抛错——防订阅到永不生效的键）
   * @param callback 生效回调（参数：新值、键名）；回调异常仅记日志
   * @returns 退订函数
   */
  onChange(key: string, callback: (value: unknown, key: string) => void): Unsubscribe {
    if (!HOT_PATH_TO_ENV.has(key)) {
      throw new BizError(ErrorCode.CONFIG_NOT_HOT, `订阅失败：${key} 不在热更新白名单内`);
    }
    const set = this.subscribers.get(key) ?? new Set<(value: unknown, key: string) => void>();
    set.add(callback);
    this.subscribers.set(key, set);
    return () => {
      set.delete(callback);
    };
  }

  /**
   * 单一生效管道入口（PRD-009 FR-05）
   *
   * 失败语义：
   * - 白名单外（5001）/ 值非法（5002）：旧值保持，失败审计尽力落盘；
   * - 审计失败：整体失败，覆盖与文件均不变（先审计后生效）；
   * - API 源持久化失败：补记一条失败审计（向排障者解释前一条「成功」审计为何未生效），进程内状态保持旧值。
   *
   * @param key 点路径（如 log.level）
   * @param value 新值（JSON 语义）
   * @param ctx 调用方上下文（来源 / 操作者）
   */
  async write(key: string, value: unknown, ctx: ConfigWriteContext): Promise<ConfigWriteResult> {
    const envKey = HOT_PATH_TO_ENV.get(key);
    if (!envKey) {
      // 已知但不可热更（boot 键）→ 5001 并审计（尝试改 boot 键属安全相关行为）；
      // 完全未知键 → 5003（可能只是手误，记 WARN 即可，不产生审计噪声）
      if (KNOWN_PATHS.has(key)) {
        await this.recordFailure(key, this.effectiveValue(key), value, ctx, '该配置键不可热更新（boot 键或不在白名单）');
        throw new BizError(ErrorCode.CONFIG_NOT_HOT, `配置键 ${key} 不可热更新（boot 键或不在白名单）`);
      }
      logger.warn('配置中心：写入未知配置键被拒', { key, source: ctx.source, operator: ctx.operator });
      throw new BizError(ErrorCode.CONFIG_NOT_FOUND, `配置键 ${key} 不存在`);
    }

    const oldValue = this.effectiveValue(key);

    // 同值写入 = 无变更：不产生审计与文件写入（审计语义是「谁改了什么」，同值不是变更）
    if (deepEqual(oldValue, value)) {
      return { key, oldValue: value, newValue: value, snapshotVersion: this.version };
    }

    // 非法值（5002）：旧值保持 + 失败审计（含被拒原因），与 PRD-009 FR-04 对齐
    try {
      this.assertValueValid(envKey, key, value);
    } catch (error) {
      if (error instanceof BizError && error.code === ErrorCode.CONFIG_INVALID_VALUE) {
        const reasons = (error.details ?? []).map((issue) => issue.message).join('；');
        await this.recordFailure(key, oldValue, value, ctx, `新值非法：${reasons || error.message}`);
      }
      throw error;
    }

    const change = {
      key,
      oldValue,
      newValue: value,
      source: ctx.source,
      operator: ctx.operator,
      operatorId: ctx.operatorId ?? null,
      ok: true,
      traceId: getTraceId() || null,
      at: this.now().toISOString(),
    };

    // 1) 先审计：落盘失败 = 整体失败（覆盖与文件均不变，满足「先审计后生效」）
    await this.auditOrThrow(change);

    // 2) API 源需持久化到事实源（file 源的事实就是文件本身，跳过）；失败则补记失败审计。
    //    持久化的是「当前覆盖 + 本次待写值」，此时覆盖尚未应用——失败则一切保持旧值。
    if (ctx.source === 'api') {
      try {
        await this.persistSnapshot(key, value);
      } catch (error) {
        const reason = `事实源持久化失败：${error instanceof Error ? error.message : String(error)}`;
        this.lastError = reason;
        logger.error('配置中心：持久化失败，变更未生效（进程内保持旧值）', { key, error: reason });
        await this.recordFailure(key, oldValue, value, ctx, reason);
        throw new BizError(ErrorCode.INTERNAL, `配置变更持久化失败，值未生效：${reason}`);
      }
    }

    // 3) 应用覆盖 → 4) 通知订阅者（版本号以持久层最新值为基线推进——多实例不撞号）
    this.overlay.set(key, value);
    this.updatedAt.set(key, change.at);
    await this.advanceVersion(ctx.source);
    this.lastAppliedAt = change.at;
    await this.recordHistory();
    this.notify(key, value);
    logger.info('配置变更已生效', { key, source: ctx.source, operator: ctx.operator, snapshotVersion: this.version });
    return { key, oldValue, newValue: value, snapshotVersion: this.version };
  }

  /**
   * 消费事实源外部快照（file 驱动轮询回调入口；PRD-009 FR-02 fail-keep）：
   * - 逐键与当前生效值 diff，仅对**真实变化**走管道（file 源免持久化）；
   * - 白名单外 / 非法值：单键拒绝并保持旧值（记失败审计 + ERROR），不影响其他键；
   * - 文件中删除的键 = 放弃覆盖，恢复 env 快照值；
   * - 解析失败由驱动拦截（不回调），进程不崩、快照保持。
   */
  async ingestExternal(snapshot: Record<string, unknown>): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    try {
      const ctx: ConfigWriteContext = { source: 'file', operator: 'system' };
      // 键级差异（新增或值变化）
      for (const [key, value] of Object.entries(snapshot)) {
        if (!HOT_PATH_TO_ENV.has(key)) {
          this.lastError = `事实源含不可热更键「${key}」，已忽略`;
          logger.error('配置中心：事实源出现不可热更键，保持旧值（fail-keep）', { key });
          await this.recordFailure(key, this.effectiveValue(key), value, ctx, '事实源键不在热更新白名单，已忽略');
          continue;
        }
        if (deepEqual(this.effectiveValue(key), value)) {
          // 值未实际变化：仅保证覆盖镜像与文件一致（不审计、不通知）
          if (!this.overlay.has(key)) {
            this.overlay.set(key, value);
            this.updatedAt.set(key, this.now().toISOString());
          }
          continue;
        }
        try {
          await this.write(key, value, ctx);
        } catch (error) {
          // 单键失败不阻断其他键（5002 已在管道内记失败审计）
          this.lastError = `键「${key}」应用失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      // 文件删除的键 → 恢复 env 快照值（审计失败只记 lastError 继续，不中断其余键的恢复）
      for (const key of [...this.overlay.keys()]) {
        if (key in snapshot) continue;
        const envKey = HOT_PATH_TO_ENV.get(key) as string;
        const envValue = this.envValue(envKey);
        const previous = this.overlay.get(key);
        if (deepEqual(previous, envValue)) {
          this.overlay.delete(key);
          continue;
        }
        try {
          await this.auditOrThrow({
            key,
            oldValue: previous,
            newValue: envValue,
            source: 'file',
            operator: 'system',
            operatorId: null,
            ok: true,
            traceId: null,
            at: this.now().toISOString(),
          });
        } catch (error) {
          this.lastError = `键「${key}」恢复默认值时审计失败：${error instanceof Error ? error.message : String(error)}`;
          continue;
        }
        this.overlay.delete(key);
        this.updatedAt.set(key, this.now().toISOString());
        await this.advanceVersion(ctx.source);
        this.lastAppliedAt = this.updatedAt.get(key) as string;
        await this.recordHistory();
        this.notify(key, envValue);
        logger.info('配置覆盖已被事实源移除，恢复 env 默认值', { key, snapshotVersion: this.version });
      }
    } finally {
      this.applying = false;
    }
  }

  /**
   * 一键回滚（M9 Backlog）：把运行时覆盖集恢复到某个历史快照版本。
   *
   * 语义与安全：
   * - `version` 缺省 = 回滚到**上一个**历史版本（当前版本之前的最近一条）；
   * - 目标版本必须仍在历史表中（仅保留最近 maxHistory 条，默认 20），已淘汰报 404/5003；
   * - 三阶段：**先全量预审计**（任一审计失败 → 整体不生效）→ **持久化目标覆盖集**（API 源；失败整体失败）
   *   → **逐键应用并通知**（与单键管道同一生效语义；目标未覆盖的键 = 恢复 env 快照值）；
   * - 回滚本身也是一次版本推进并计入历史（回滚后可再回滚）；
   * - 目标状态与当前一致（无差异键）→ 不产生审计与持久化，版本号不变。
   *
   * @param targetVersion 目标历史版本号（缺省 = 上一个版本）
   * @param ctx 调用方上下文（api 源；回滚仅开放给管理端点）
   */
  async rollback(targetVersion: number | undefined, ctx: ConfigWriteContext): Promise<ConfigRollbackResult> {
    const fromVersion = await this.syncRemoteVersion();
    // 回滚候选集：注入持久历史时跨实例可见（A 实例写入的版本 B 实例可回滚——AC2），
    // 缺省 = 进程内环形表（M9 原行为）
    let candidates: ConfigSnapshotEntry[];
    if (this.historyPort) {
      try {
        candidates = await this.historyPort.list(this.maxHistory);
      } catch (error) {
        throw new BizError(ErrorCode.INTERNAL, `读取配置历史失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      candidates = [...this.history].sort((a, b) => b.version - a.version);
    }
    let entry: ConfigSnapshotEntry;
    if (targetVersion === undefined) {
      const previous = candidates.find((e) => e.version < fromVersion);
      if (!previous) {
        throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '没有可回滚的历史版本（启动后无成功变更）');
      }
      entry = previous;
    } else {
      const found = candidates.find((e) => e.version === targetVersion);
      if (!found) {
        throw new BizError(
          ErrorCode.CONFIG_NOT_FOUND,
          `配置历史版本 ${targetVersion} 不存在（仅保留最近 ${this.maxHistory} 个版本）`,
        );
      }
      entry = found;
    }

    // 差集计算：目标覆盖集 vs 当前覆盖集（键新增/值变化 → 写入；键移除 → 恢复 env 默认）
    const target = entry.overlay;
    const changes: Array<ConfigRollbackChange & { envKey: string; unset: boolean }> = [];
    for (const [key, value] of Object.entries(target)) {
      const envKey = HOT_PATH_TO_ENV.get(key);
      if (!envKey) continue; // 历史条目只可能来自白名单键；防御性跳过
      const oldValue = this.effectiveValue(key);
      if (deepEqual(oldValue, value)) continue;
      changes.push({ key, oldValue, newValue: value, envKey, unset: false });
    }
    for (const key of this.overlay.keys()) {
      if (key in target) continue;
      const envKey = HOT_PATH_TO_ENV.get(key);
      if (!envKey) continue;
      const oldValue = this.overlay.get(key);
      const newValue = this.envValue(envKey);
      if (deepEqual(oldValue, newValue)) continue; // 覆盖值与 env 默认相同：无生效差异，无需动
      changes.push({ key, oldValue, newValue, envKey, unset: true });
    }
    if (changes.length === 0) {
      return { fromVersion, toVersion: entry.version, changed: [], snapshotVersion: this.version };
    }

    // 阶段 1：全量预审计（任一失败 → 整体失败，不落持久化、不应用）
    const at = this.now().toISOString();
    for (const change of changes) {
      await this.auditOrThrow({
        key: change.key,
        oldValue: change.oldValue,
        newValue: change.newValue,
        source: ctx.source,
        operator: ctx.operator,
        operatorId: ctx.operatorId ?? null,
        ok: true,
        traceId: getTraceId() || null,
        at,
      });
    }

    // 阶段 2：持久化目标覆盖集（API 源；与单键管道一致，先落盘后生效）
    if (ctx.source === 'api') {
      try {
        await this.driver.write({ ...target });
      } catch (error) {
        const reason = `回滚持久化失败：${error instanceof Error ? error.message : String(error)}`;
        this.lastError = reason;
        logger.error('配置中心：回滚持久化失败（进程内保持回滚前状态）', { targetVersion: entry.version, error: reason });
        throw new BizError(ErrorCode.INTERNAL, `配置回滚持久化失败，未生效：${reason}`);
      }
    }

    // 阶段 3：逐键应用并通知
    for (const change of changes) {
      if (change.unset) this.overlay.delete(change.key);
      else this.overlay.set(change.key, change.newValue);
      this.updatedAt.set(change.key, at);
      this.notify(change.key, change.newValue);
    }
    await this.advanceVersion(ctx.source);
    this.lastAppliedAt = at;
    await this.recordHistory();
    logger.info('配置已回滚', {
      fromVersion,
      toVersion: entry.version,
      snapshotVersion: this.version,
      keys: changes.map((c) => c.key),
      operator: ctx.operator,
    });
    return {
      fromVersion,
      toVersion: entry.version,
      changed: changes.map(({ key, oldValue, newValue }) => ({ key, oldValue, newValue })),
      snapshotVersion: this.version,
    };
  }

  /** 快照历史条目数（诊断用；注入持久历史时为本地环形表条数） */
  get historySize(): number {
    return this.history.length;
  }

  /**
   * 对齐远端版本基线（M10 E-02，GET /configs 读取路径用）：
   * 注入持久历史时取持久层最新版本与本地取大——A 实例写入的版本，B 实例无需等待本地写操作
   * 即可在 meta.snapshotVersion 上读到一致值（AC2）；缺省直接返回本地版本号（原行为）。
   */
  async syncRemoteVersion(): Promise<number> {
    if (!this.historyPort) return this.version;
    try {
      const remote = await this.historyPort.latest();
      this.version = Math.max(this.version, remote?.version ?? 0);
    } catch (error) {
      logger.warn('配置中心：读取持久历史最新版本失败（按本地版本号返回）', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.version;
  }

  /** 白名单键列表（GET /configs 数据源；boot 键不进列表——env 独占，重启变更） */
  list(): ConfigEntryView[] {
    return HOT_PATHS.map((key) => {
      const envKey = HOT_PATH_TO_ENV.get(key) as string;
      const overridden = this.overlay.has(key);
      return {
        key,
        value: this.effectiveValue(key),
        source: overridden ? ('runtime' as const) : ('env' as const),
        hot: true as const,
        envKey,
        updatedAt: overridden ? (this.updatedAt.get(key) ?? null) : null,
      };
    });
  }

  /** 运行元信息（诊断用，不阻塞就绪判定） */
  meta(): ConfigCenterMeta {
    return {
      driver: this.driver.kind,
      snapshotVersion: this.version,
      pollSeconds: this.driver.pollSeconds ?? null,
      lastAppliedAt: this.lastAppliedAt,
      lastError: this.lastError,
    };
  }

  /** 键判别：hot（白名单内）/ known（已知 boot 键）/ unknown（未知）——控制器映射 200/5001/5003 */
  describeKey(key: string): 'hot' | 'known' | 'unknown' {
    if (HOT_PATH_TO_ENV.has(key)) return 'hot';
    if (KNOWN_PATHS.has(key)) return 'known';
    return 'unknown';
  }

  /** 当前生效值（覆盖优先，回退 env 快照） */
  private effectiveValue(key: string): unknown {
    if (this.overlay.has(key)) return this.overlay.get(key);
    const envKey = HOT_PATH_TO_ENV.get(key);
    return envKey ? this.envValue(envKey) : undefined;
  }

  private envValue(envKey: string): unknown {
    return (this.env as Record<string, unknown>)[envKey];
  }

  /** 复用与 env 同一份 zod 校验器（PRD-009 FR-04）；失败抛 5002（details 带原因） */
  private assertValueValid(envKey: string, key: string, value: unknown): void {
    const candidate = { ...(this.env as Record<string, unknown>), [envKey]: value };
    const parsed = envSchema.safeParse(candidate);
    if (parsed.success) return;
    const details = parsed.error.issues
      .filter((issue) => issue.path[0] === envKey)
      .map((issue) => ({ field: key, message: issue.message }));
    throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `配置键 ${key} 的新值非法`, details.length > 0 ? details : undefined);
  }

  /** 成功变更审计：抛错 = 审计失败（包装为 INTERNAL，调用方整体失败且不应用变更） */
  private async auditOrThrow(change: Parameters<ConfigAuditPort['recordChange']>[0]): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.recordChange(change);
    } catch (error) {
      throw new BizError(ErrorCode.INTERNAL, `配置变更审计失败，变更未生效：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 失败变更审计：尽力落盘（失败仅记 ERROR，拒绝结果不受影响） */
  private async recordFailure(key: string, oldValue: unknown, newValue: unknown, ctx: ConfigWriteContext, reason: string): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.recordChange({
        key,
        oldValue,
        newValue,
        source: ctx.source,
        operator: ctx.operator,
        operatorId: ctx.operatorId ?? null,
        ok: false,
        reason,
        traceId: getTraceId() || null,
        at: this.now().toISOString(),
      });
    } catch (error) {
      logger.error('配置中心：失败变更审计落盘失败（拒绝结果不变）', {
        key,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 全量覆盖镜像原子写回事实源（API 源专用）；pending 为本次待应用的键值（应用覆盖前先落盘） */
  private async persistSnapshot(pendingKey: string, pendingValue: unknown): Promise<void> {
    const snapshot: Record<string, unknown> = {};
    for (const [key, value] of this.overlay) snapshot[key] = value;
    snapshot[pendingKey] = pendingValue;
    await this.driver.write(snapshot);
  }

  /**
   * 记录当前版本的覆盖集快照（每次版本推进后调用）：
   * 本地环形表恒维护（M9 原行为；诊断与缺省回滚数据源）；注入持久历史时同步 append
   * （失败仅 WARN——历史缺失一条影响回滚候选，不影响已生效值与事实源权威性）。
   */
  private async recordHistory(): Promise<void> {
    const entry: ConfigSnapshotEntry = {
      version: this.version,
      at: this.lastAppliedAt ?? this.now().toISOString(),
      overlay: Object.fromEntries(this.overlay),
    };
    this.history.push(entry);
    while (this.history.length > this.maxHistory) this.history.shift();
    if (this.historyPort) {
      try {
        await this.historyPort.append(entry);
      } catch (error) {
        logger.warn('配置中心：快照历史持久化失败（本版本将缺席跨实例回滚候选）', {
          version: this.version,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * 版本推进（M10 E-02）：
   * - 未注入持久历史：本地 +1（M9 原行为）；
   * - 注入持久历史 + api/rollback 源：以持久层最新版本为基线取大 +1（多实例不撞号）；
   * - 注入持久历史 + file 源（外部事实源轮询）：若持久层已有比本地更新的版本（其他实例
   *   为同一变更登记过）→ **对齐不推号**（B 实例追上 A 的 v2 而非另占 v3）；否则推新号
   *   （无任何实例登记过的外部变更，如直改 Nacos 控制台）。
   */
  private async advanceVersion(source: ConfigWriteContext['source']): Promise<void> {
    if (!this.historyPort) {
      this.version += 1;
      return;
    }
    try {
      const remote = await this.historyPort.latest();
      const remoteVersion = remote?.version ?? 0;
      if (source === 'file' && remoteVersion > this.version) {
        this.version = remoteVersion;
        return;
      }
      this.version = Math.max(this.version, remoteVersion) + 1;
    } catch (error) {
      logger.warn('配置中心：推进版本号前读取持久历史失败（按本地版本号推进）', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.version += 1;
    }
  }

  /** 通知订阅者：单订阅者异常不影响其他订阅者与生效结果（值已生效，通知失败不回滚） */
  private notify(key: string, value: unknown): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    for (const callback of set) {
      try {
        callback(value, key);
      } catch (error) {
        logger.error('配置订阅回调异常（不影响已生效值）', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

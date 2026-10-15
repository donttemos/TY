/*
 * @file Nacos 事实源驱动（M9 Backlog 示例实现：ConfigCenterDriverPort 注册位落地）
 * @description 走 Nacos v1 HTTP Open API（不依赖 nacos SDK，Node 20+ 内置 fetch 即可）：
 *   读 = GET /nacos/v1/cs/configs（404 → null，由上层决定 fail-open）；
 *   写 = POST /nacos/v1/cs/configs（发布 json 配置）；变更发现 = 内容 MD5 周期轮询
 *   （不用 Nacos 长轮询监听端点——保持与 file 适配一致的「简单周期轮询」语义，多实例安全）。
 *   **示例定位**：多实例部署把覆盖值收敛到 Nacos 一处（file 适配是多实例竞态的），
 *   落地项目在装配处实例化并注入 ConfigCenterService（CONFIG_CENTER_DRIVER 枚举仍仅 file，
 *   环境契约不变——该驱动按代码注册而非 env 切换）。
 * @author donttemo
 * @created 2026-10-15
 * @module config-center
 */
import { createHash } from 'node:crypto';
import { Logger } from '@fw/logger';
import type { ConfigDriverPort } from '../types.js';

const logger = Logger.for('config.nacos');

/** fetch 注入（测试用）：与全局 fetch 同签名 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<ResponseLike>;

/** 响应最小面（测试桩注入；缺省即全局 Response） */
export interface ResponseLike {
  status: number;
  text(): Promise<string>;
}

/** 定时器注入（测试用） */
export type SetIntervalFn = (handler: () => void, timeoutMs: number) => unknown;

/** 清理定时器注入（测试用） */
export type ClearIntervalFn = (timer: unknown) => void;

/** 驱动选项 */
export interface NacosConfigDriverOptions {
  /** Nacos 服务地址（如 http://nacos:8848；不带 /nacos 尾径） */
  serverAddr: string;
  /** 配置 ID（dataId，对应一份运行时覆盖 JSON） */
  dataId: string;
  /** 分组（缺省 DEFAULT_GROUP） */
  group?: string;
  /** 命名空间（tenant；缺省 public） */
  namespace?: string;
  /** 鉴权用户名（Nacos 开启鉴权时必填，配合 password） */
  username?: string;
  /** 鉴权密码 */
  password?: string;
  /** 轮询间隔（秒，≥1；缺省 5） */
  pollSeconds?: number;
  /** fetch 注入（测试用；缺省全局 fetch） */
  fetchFn?: FetchLike;
  /** 轮询定时器注入（测试用） */
  setIntervalFn?: SetIntervalFn;
  /** 清理定时器注入（测试用） */
  clearIntervalFn?: ClearIntervalFn;
}

/** md5 指纹（内容变更判别） */
function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * Nacos 驱动：load / 发布 / 内容 MD5 轮询
 *
 * 与 file 适配的语义差异：Nacos 天然多实例共享（一处事实源），写为「发布」语义；
 * 读取 / 发布失败不抛到轮询回调外（记日志，保持上层最后一份有效快照）。
 */
export class NacosConfigDriver implements ConfigDriverPort {
  readonly kind = 'nacos';

  readonly pollSeconds: number;

  private readonly serverAddr: string;

  private readonly dataId: string;

  private readonly group: string;

  private readonly namespace?: string;

  private readonly username?: string;

  private readonly password?: string;

  private readonly fetchFn: FetchLike;

  private readonly setIntervalFn: SetIntervalFn;

  private readonly clearIntervalFn: ClearIntervalFn;

  private timer: unknown;

  /** 在途轮询（测试可等待） */
  private inFlight: Promise<void> | undefined;

  /** 上次识别到的内容指纹（抑制重复回调与自触发） */
  private fingerprint: string | null = null;

  /** 鉴权 accessToken（惰性获取；未配鉴权为 null） */
  private accessToken: string | null = null;

  constructor(options: NacosConfigDriverOptions) {
    this.serverAddr = options.serverAddr.replace(/\/+$/, '');
    this.dataId = options.dataId;
    this.group = options.group ?? 'DEFAULT_GROUP';
    this.namespace = options.namespace;
    this.username = options.username;
    this.password = options.password;
    this.pollSeconds = Math.max(1, Math.round(options.pollSeconds ?? 5));
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init) as Promise<ResponseLike>);
    this.setIntervalFn = options.setIntervalFn ?? ((handler, timeoutMs) => setInterval(handler, timeoutMs));
    this.clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  }

  /** 全量读取：404 / 网络失败 → null（上层 fail-open / fail-keep） */
  async load(): Promise<Record<string, unknown> | null> {
    const raw = await this.fetchConfig();
    if (raw === null) return null;
    return this.parseSnapshot(raw, true);
  }

  /** 发布全量覆盖快照（Nacos 写语义 = 发布同 dataId 的新版本内容） */
  async write(snapshot: Record<string, unknown>): Promise<void> {
    await this.ensureAccessToken();
    const params = new URLSearchParams();
    params.set('dataId', this.dataId);
    params.set('group', this.group);
    if (this.namespace) params.set('tenant', this.namespace);
    if (this.accessToken) params.set('accessToken', this.accessToken);
    params.set('content', JSON.stringify(snapshot, null, 2));
    params.set('type', 'json');
    const res = await this.fetchFn(`${this.serverAddr}/nacos/v1/cs/configs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (res.status !== 200 || (await res.text()).trim() !== 'true') {
      throw new Error(`Nacos 配置发布失败：http=${res.status}`);
    }
    // 写后更新指纹，抑制下一轮轮询自触发（与 file 驱动同策略）
    this.fingerprint = md5(JSON.stringify(snapshot, null, 2));
    logger.debug('Nacos 配置已发布', { dataId: this.dataId, group: this.group });
  }

  /** 内容 MD5 周期轮询：内容变化且解析有效才回调（解析失败保持上层快照） */
  watch(onChange: (snapshot: Record<string, unknown>) => void): void {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => {
      this.inFlight = this.poll(onChange).catch((error: unknown) => {
        logger.error('Nacos 配置轮询异常（本轮跳过，保持最后一份有效快照）', {
          dataId: this.dataId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.pollSeconds * 1000);
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** 等待最近一轮轮询结束（测试用） */
  async settle(): Promise<void> {
    await this.inFlight;
  }

  /** 释放轮询定时器 */
  async stop(): Promise<void> {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  /** 拉取原始配置文本；不存在返回 null */
  private async fetchConfig(): Promise<string | null> {
    await this.ensureAccessToken();
    const params = new URLSearchParams();
    params.set('dataId', this.dataId);
    params.set('group', this.group);
    if (this.namespace) params.set('tenant', this.namespace);
    if (this.accessToken) params.set('accessToken', this.accessToken);
    const res = await this.fetchFn(`${this.serverAddr}/nacos/v1/cs/configs?${params.toString()}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`Nacos 配置读取失败：http=${res.status}`);
    return res.text();
  }

  /** 单轮轮询：指纹变化才解析回调 */
  private async poll(onChange: (snapshot: Record<string, unknown>) => void): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.fetchConfig();
    } catch (error) {
      logger.error('Nacos 配置读取失败，保持最后一份有效快照', {
        dataId: this.dataId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (raw === null) return; // 配置被删除：不动运行态（与 file 驱动「文件缺失 fail-open」只在启动期生效的语义区分）
    const fingerprint = md5(raw);
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    const snapshot = this.parseSnapshot(raw, false);
    if (snapshot === null) return;
    onChange(snapshot);
  }

  /** 解析快照 JSON；解析失败按 startup 区分日志级别并返回 null（fail-open / fail-keep） */
  private parseSnapshot(raw: string, startup: boolean): Record<string, unknown> | null {
    if (raw.trim() === '') return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('顶层必须是 JSON 对象（点路径 → 值）');
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      const message = `Nacos 配置 JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`;
      if (startup) logger.warn('配置中心启动：Nacos 配置损坏，按 env 快照启动（fail-open）', { dataId: this.dataId, error: message });
      else logger.error('Nacos 配置损坏，保持最后一份有效快照（fail-keep）；修复后将自动追上', { dataId: this.dataId, error: message });
      return null;
    }
  }

  /** 惰性登录（开启鉴权的 Nacos；失败抛错由调用方按 fail-keep 处理） */
  private async ensureAccessToken(): Promise<void> {
    if (!this.username || !this.password || this.accessToken) return;
    const params = new URLSearchParams();
    params.set('username', this.username);
    params.set('password', this.password);
    const res = await this.fetchFn(`${this.serverAddr}/nacos/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (res.status !== 200) throw new Error(`Nacos 登录失败：http=${res.status}`);
    const body = JSON.parse(await res.text()) as { accessToken?: string };
    this.accessToken = body.accessToken ?? null;
  }
}

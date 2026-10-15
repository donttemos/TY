/*
 * @file 本地文件事实源驱动（PRD-009 FR-02）
 * @description 运行时配置文件（默认 ./config/runtime.json）+ mtime 轮询（不用 fs.watch——跨平台语义不可靠）；
 *   写走原子写（临时文件 + rename）；读失败 / 语法错误不回调（上层保持最后一份有效快照）。
 *   单实例语义：多实例共享本地文件有覆盖竞态，多实例场景应实现 Nacos adapter（文档已明示）。
 * @author donttemo
 * @created 2026-10-15
 * @module config-center
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Logger } from '@fw/logger';
import type { ConfigDriverPort } from '../types.js';

const logger = Logger.for('config.file');

/** 定时器注入（测试用）：返回任意句柄，语义为「按毫秒周期执行 handler」 */
export type SetIntervalFn = (handler: () => void, timeoutMs: number) => unknown;

/** 清理定时器注入（测试用） */
export type ClearIntervalFn = (timer: unknown) => void;

/** 驱动选项 */
export interface FileConfigDriverOptions {
  /** 运行时配置文件路径 */
  file: string;
  /** mtime 轮询间隔（秒，≥1） */
  pollSeconds: number;
  /** 轮询定时器注入（测试用；缺省全局 setInterval） */
  setIntervalFn?: SetIntervalFn;
  /** 清理定时器注入（测试用；缺省全局 clearInterval） */
  clearIntervalFn?: ClearIntervalFn;
}

/**
 * 本地文件驱动：load / 原子写 / mtime 轮询
 */
export class FileConfigDriver implements ConfigDriverPort {
  readonly kind = 'file';

  readonly pollSeconds: number;

  private readonly file: string;

  private readonly setIntervalFn: SetIntervalFn;

  private readonly clearIntervalFn: ClearIntervalFn;

  private timer: unknown;

  /** 最近一轮轮询的 Promise（诊断与测试可等待；轮询体自身不抛错） */
  private inFlight: Promise<void> | undefined;

  /** 上次识别到的文件指纹（mtimeMs + size），用于抑制重复读与自触发 */
  private fingerprint: string | null = null;

  constructor(options: FileConfigDriverOptions) {
    this.file = options.file;
    this.pollSeconds = Math.max(1, Math.round(options.pollSeconds));
    this.setIntervalFn = options.setIntervalFn ?? ((handler, timeoutMs) => setInterval(handler, timeoutMs));
    this.clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  }

  /**
   * 全量读取：缺失 → null（上层 fail-open）；JSON 语法错误 → null（记 ERROR，上层保持快照语义与运行期一致）
   */
  async load(): Promise<Record<string, unknown> | null> {
    return this.readSnapshot(true);
  }

  /**
   * 原子写入：同目录临时文件 + rename（rename 同卷原子）。写入成功后更新指纹，抑制下一轮自触发。
   * 目录不存在时自动创建（首启无 config/ 目录的场景）。
   */
  async write(snapshot: Record<string, unknown>): Promise<void> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    await rename(tmp, this.file);
    const next = await stat(this.file).catch(() => undefined);
    this.fingerprint = next ? `${next.mtimeMs}:${next.size}` : null;
  }

  /**
   * mtime 轮询：指纹变化才读文件；读取 / 解析失败记日志并跳过本轮（保持上层最后一份有效快照），
   * 文件恢复后指纹变化会自动追上（fail-keep + 自动恢复）。
   */
  watch(onChange: (snapshot: Record<string, unknown>) => void): void {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => {
      this.inFlight = this.poll(onChange).catch(() => undefined);
    }, this.pollSeconds * 1000);
    // 不阻塞进程退出（句柄为真实 Timeout 对象时才具备 unref）
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** 等待最近一轮（可能在途的）轮询结束（测试用） */
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

  /** 单轮轮询 */
  private async poll(onChange: (snapshot: Record<string, unknown>) => void): Promise<void> {
    let info;
    try {
      info = await stat(this.file);
    } catch {
      // 文件暂不可见（被替换中 / 暂时移除）：记一次 debug，等指纹恢复后自动追上
      logger.debug('配置事实源暂不可读，等待恢复', { file: this.file });
      return;
    }
    const fingerprint = `${info.mtimeMs}:${info.size}`;
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    const snapshot = await this.readSnapshot(false);
    if (snapshot === null) return;
    onChange(snapshot);
  }

  /** 读取 + 解析；startup 为 true 时缺失也返回 null（语义一致：fail-open），错误日志级别按 startup 区分 */
  private async readSnapshot(startup: boolean): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.error('配置事实源读取失败，保持最后一份有效快照', { file: this.file, error: String(error) });
      }
      return null;
    }
    if (text.trim() === '') return {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('顶层必须是 JSON 对象（点路径 → 值）');
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      const message = `配置事实源 JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`;
      if (startup) {
        logger.warn('配置中心启动：事实源损坏，按 env 快照启动（fail-open）', { file: this.file, error: message });
      } else {
        logger.error('配置事实源损坏，保持最后一份有效快照（fail-keep）；修复文件后将自动追上', {
          file: this.file,
          error: message,
        });
      }
      return null;
    }
  }
}

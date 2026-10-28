/*
 * @file Studio 任务执行器（PRD-017 FR-17-13/16）
 * @description 把「调用 CLI」收敛成一个受控组件：
 *   - **只接受白名单动作**（gen / deploy / verify 将来逐个接入），命令与参数由服务端拼装，
 *     前端永远只能提交动作名与数据，不能提交命令行字符串——这是 Studio 不变成远程 shell 的底线；
 *   - 子进程输出按行缓存（带上限），失败也保留现场；进程被杀/超时都有明确状态；
 *   - 同一时刻只允许一个写任务（schema 写入与生成都改文件，并发会互相踩）。
 *   采用「启动 + 轮询」而不是 SSE：本地工具 2 次/秒轮询足够，且不依赖代理/缓冲行为。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/studio
 * @since v0.8.0
 */

import { spawn } from 'node:child_process';

/** 任务状态 */
export type JobStatus = 'running' | 'succeeded' | 'failed' | 'killed';

/** 任务记录 */
export interface JobRecord {
  id: string;
  /** 人类可读的动作名（用于界面标题） */
  action: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  /** 输出行（末尾若干行；超出上限时截断保留尾部） */
  lines: string[];
  /** 失败摘要（首条有意义的错误行） */
  error?: string;
}

/** 进程句柄（可注入，单测不真起进程） */
export interface JobProcess {
  onLine: (handler: (line: string) => void) => void;
  onExit: (handler: (code: number | null) => void) => void;
}

/** 拉起进程（可注入） */
export type JobSpawner = (command: string, args: string[], cwd: string) => JobProcess;

/** 保留的最大输出行数（防止长任务把内存吃满） */
const MAX_LINES = 2000;

/** 默认拉起器：合并 stdout/stderr，按行回调 */
const defaultSpawner: JobSpawner = (command, args, cwd) => {
  const child = spawn(command, args, { cwd, shell: false });
  const handlers: ((line: string) => void)[] = [];
  const exitHandlers: ((code: number | null) => void)[] = [];
  let buffer = '';

  const emit = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.replace(/\r$/, '');
      if (line.trim() !== '') for (const handler of handlers) handler(line);
    }
  };
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);
  child.on('error', (error: Error) => {
    for (const handler of handlers) handler(`[studio] 启动失败：${error.message}`);
    for (const handler of exitHandlers) handler(1);
  });
  child.on('close', (code) => {
    // 冲掉最后一行（没有换行结尾时）
    if (buffer.trim() !== '') for (const handler of handlers) handler(buffer.replace(/\r$/, ''));
    buffer = '';
    for (const handler of exitHandlers) handler(code);
  });

  return {
    onLine: (handler) => handlers.push(handler),
    onExit: (handler) => exitHandlers.push(handler),
  };
};

/** 判断某行是否是「像错误」的行（用于失败摘要） */
function looksLikeError(line: string): boolean {
  return /error|\bfailed\b|失败|✗|P\d{4}|\bthrow\b/i.test(line) && !/^\s*warn\b/i.test(line);
}

/** 任务管理器 */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private counter = 0;
  private running: string | null = null;

  /**
   * @param spawner 拉起进程（可注入）
   * @param now 时钟（测试固定）
   */
  constructor(
    private readonly spawner: JobSpawner = defaultSpawner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 启动任务
   * @param spec 动作名与命令
   * @returns 任务 id；已有任务在跑时抛错
   */
  start(spec: { action: string; command: string; args: string[]; cwd: string }): string {
    if (this.running) {
      throw new Error('已有任务在执行，请等它结束（同一时刻只允许一个写任务）');
    }
    const id = `job-${(this.counter += 1)}`;
    const record: JobRecord = {
      id,
      action: spec.action,
      status: 'running',
      startedAt: this.now().toISOString(),
      finishedAt: null,
      exitCode: null,
      lines: [],
    };
    this.jobs.set(id, record);
    this.running = id;

    const process = this.spawner(spec.command, spec.args, spec.cwd);
    process.onLine((line) => {
      record.lines.push(line);
      if (record.lines.length > MAX_LINES) record.lines.splice(0, record.lines.length - MAX_LINES);
    });
    process.onExit((code) => {
      record.exitCode = code;
      record.status = code === 0 ? 'succeeded' : 'failed';
      record.finishedAt = this.now().toISOString();
      if (code !== 0) {
        record.error = [...record.lines].reverse().find(looksLikeError) ?? record.lines[record.lines.length - 1];
      }
      this.running = null;
    });
    return id;
  }

  /**
   * 读取任务
   * @param id 任务 id
   */
  get(id: string): JobRecord | null {
    return this.jobs.get(id) ?? null;
  }

  /** 当前是否有任务在跑 */
  isBusy(): boolean {
    return this.running !== null;
  }
}

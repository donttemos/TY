/*
 * @file 任务中心端口（M10 E-01）
 * @description 任务中心的驱动端口与共享类型：create/get/retry/artifact 四个能力构成端口面，
 *   memory（默认，N-02 原行为）/ db（登记落库 + 派发实例执行）/ bullmq（登记落库 + 队列分发执行）
 *   三种驱动实现同一端口。类型从 job-center.service.ts 迁入此处（端口是类型的家），
 *   service 文件 re-export 保持既有 import 路径兼容。
 *   多副本语义（PRD-010 E-01 / AC1）：db 与 bullmq 驱动下，进度 / 下载 / 重跑请求落在任意实例
 *   都能从持久层读到同一份任务状态，不再依赖「派发请求与查询请求落在同一进程」。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

/** 任务状态机 */
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** 任务中心驱动可选值（与 @fw/config 的 JOB_CENTER_DRIVER 枚举一致；kafka 式执行面另议不入） */
export const JOB_CENTER_DRIVER_VALUES = ['memory', 'db', 'bullmq'] as const;

/** 任务中心驱动名 */
export type JobCenterDriverName = (typeof JOB_CENTER_DRIVER_VALUES)[number];

/** 任务产物（当前仅文本类：CSV / JSON 等） */
export interface JobArtifact {
  /** 下载文件名（含扩展名） */
  fileName: string;
  /** MIME 类型 */
  contentType: string;
  /** 文本内容 */
  content: string;
}

/** 对外任务视图（`GET /jobs/:id/progress` 的 data） */
export interface JobView {
  id: string;
  /** 任务类型（如 `audit.export` / `tenant.migrate`） */
  type: string;
  /** 展示标题（任务条上的文案） */
  title: string;
  status: JobStatus;
  /** 进度百分比 0–100 */
  progress: number;
  /** 最近一条进度说明 */
  message: string | null;
  /** 失败原因（status=failed 时非空），响应里与 traceId 一起供报障 */
  error: string | null;
  /** 链路 ID（与日志 / 审计一致） */
  traceId: string;
  /** 产物文件名（status=succeeded 时非空，前端据此展示「下载」） */
  fileName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 进度上报函数：0–100 + 可选说明 */
export type JobReporter = (progress: number, message?: string) => void;

/** 任务执行体 */
export type JobRunner = (report: JobReporter) => Promise<JobArtifact | null>;

/** 派发入参 */
export interface JobCreateOptions {
  type: string;
  title: string;
  /** 任务归属人（进度 / 重跑 / 下载的鉴权依据） */
  ownerId: string;
  /** 业务入参（回显用；重跑沿用同一闭包，无需再次解析） */
  params?: Record<string, unknown>;
  /** 链路 ID（缺省取当前请求上下文） */
  traceId?: string;
  /**
   * 执行体闭包（可选）：memory 驱动的既有形态；db 驱动下「派发实例」仍可用闭包立即执行，
   * 但**跨实例重跑一律走 `JobRunnerRegistry` 按 type 重建**（闭包不落盘），故 db / bullmq
   * 驱动的任务类型必须在注册表登记 factory，否则重跑给出可读 reason 而非静默失败。
   */
  runner?: JobRunner;
}

/** 任务中心驱动端口：派发 / 查询 / 重跑 / 取产物 */
export interface JobCenterPort {
  /** 驱动名（供 /ready 与运维面展示） */
  readonly kind: JobCenterDriverName;

  /** 派发任务：立即返回视图（status=pending），执行在后台进行 */
  create(options: JobCreateOptions): JobView;

  /**
   * 读取任务视图（仅归属人可见；不匹配返回 null，由调用方转 404 不泄露存在性）。
   * memory 驱动同步返回（进程内查表）；db / bullmq 驱动返回 Promise（读库）——
   * 调用方统一 `await`（await 同步值无副作用），既有同步单测只对 memory 成立、零改动。
   */
  get(id: string, ownerId: string): JobView | null | Promise<JobView | null>;

  /** 原地重跑（仅失败任务）；任务不存在 / 非归属人返回 view=null，状态不允许返回 reason。同步性约定同 get */
  retry(id: string, ownerId: string): { view: JobView | null; reason?: string } | Promise<{ view: JobView | null; reason?: string }>;

  /** 取任务产物（仅归属人）。同步性约定同 get */
  artifact(id: string, ownerId: string): JobArtifact | null | Promise<JobArtifact | null>;
}

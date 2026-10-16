/*
 * @file 任务事件汇（M10 E-12）
 * @description 任务中心 → SSE 通道的单向事件出口。设计取舍：**不把发布端口注入驱动的构造函数**，
 *   而是用模块级汇（先例：`@fw/cache` 的 `setGlobalRateLimiter`）——
 *   ① memory 驱动「无参构造 = N-02 原行为」的既有契约与单测零改动；
 *   ② 三种驱动（memory / db / bullmq）与 JobExecutor 分处不同执行路径，都要能发事件，
 *      经构造函数逐层透传会把事件面污染到全部签名上；
 *   ③ 事件面是「可选的旁路」——未装配（无 sink）时 `emitJobEvent` 是空操作，
 *      任务执行路径不受任何影响（sink 内部异常同样被吞掉）。
 *   仅发状态**变更**（创建 / 首次 running / 进度推进 / 终态），不改变任务语义本身。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import type { JobView } from './job-center.port.js';

/** 任务事件类型：created（已派发）/ progress（运行中或进度推进）/ finished（终态） */
export type JobEventKind = 'created' | 'progress' | 'finished';

/** 任务事件载荷（经 `@fw/transport` 事件面广播；SSE 层按 ownerId 过滤后下发） */
export interface JobEventPayload {
  /** 事件类型 */
  kind: JobEventKind;
  /** 任务视图快照（与 `GET /jobs/:id/progress` 同形，前端零转换消费） */
  job: JobView;
  /** 任务归属人（SSE 层的可见性边界） */
  ownerId: string;
}

/** 事件汇签名 */
export type JobEventSink = (payload: JobEventPayload) => void;

let sink: JobEventSink | undefined;

/**
 * 装配事件汇（EventsModule 启动期调用；传 undefined 解除装配）
 * @param next 事件汇，或 undefined
 */
export function setJobEventSink(next: JobEventSink | undefined): void {
  sink = next;
}

/**
 * 发出一条任务事件（未装配汇时为无害空操作；汇异常不得影响任务执行）
 * @param kind 事件类型
 * @param job 任务视图
 * @param ownerId 归属人
 */
export function emitJobEvent(kind: JobEventKind, job: JobView, ownerId: string): void {
  if (!sink) return;
  try {
    sink({ kind, job: { ...job }, ownerId });
  } catch {
    // 事件面故障（传输不可用等）只影响实时推送，任务本身照常推进
  }
}

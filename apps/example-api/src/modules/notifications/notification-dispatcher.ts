/*
 * @file 通知派发器（M10 E-13「业务侧经事件订阅」的落点）
 * @description 站内信**不由业务代码直接调用**产生，而是订阅 `@fw/transport` 事件面后按规则落库——
 *   这是 E-13 与 E-12 的接缝：任务中心 / 队列只负责「发生了什么」（事件），
 *   通知中心只负责「该告诉谁」（订阅 + 收件人解析），两侧互不 import 对方的服务。
 *
 *   映射规则：
 *   - `job.progress` 且 `kind=finished` → 派发人一条（成功 / 失败分级别，附产物文件名或失败原因）；
 *     运行中的进度事件**不通知**（那是任务条的事，写进站内信只会变成噪声）；
 *   - `queue.alert` → 持 `system:queue:list` 的账号各一条（死信 error / 积压 warning）——
 *     队列是运维面，收件人按权限码解析而不是硬编码收件人列表。
 *
 *   幂等与多副本：`dedupeKey` 唯一（存储层唯一约束）。redis 事件面下**每个副本都会收到同一条事件**，
 *   于是每个副本都会尝试写通知——唯一约束让只有一个成功，其余静默跳过（无需分布式锁，
 *   与「先查后写」相比没有竞态窗口）。任务重跑再次终态时 `updatedAt` 变化 → 幂等键不同 → 会产生
 *   新的一条通知，符合「重跑完成值得再提醒一次」的预期。
 *
 *   事件面不可用（驱动不支持 / 无 Redis 等）时**降级**：订阅失败只记日志，通知退化为
 *   「进入消息中心才可见」（REST 面与 SSE 互不阻塞），不影响任务与队列本身。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/notifications
 */

import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { QUEUE_PERM_LIST } from '@fw/queue';
import { Logger } from '@fw/logger';
import { TransportService } from '@fw/transport';
import { JOB_TOPIC, NOTIFICATION_TOPIC, QUEUE_TOPIC } from '../events/topics.js';
import type { JobEventPayload } from '../jobs/job-events.js';
import type { QueueAlertPayload } from '../events/queue-alerts.js';
import { NotificationService, toView } from './notification.service.js';
import type { NotificationRow } from './notification.store.js';

const logger = Logger.for('notifications');

/** `notification.created` 事件的载荷（SSE 层按 ownerId 过滤后下发） */
export interface NotificationCreatedPayload {
  /** 收件人（可见性边界） */
  ownerId: string;
  /** 通知视图（与 `GET /notifications` 列表项同形，前端零转换消费） */
  notification: ReturnType<typeof toView>;
}

/**
 * 通知派发器：事件订阅 → 落库 → 广播 `notification.created`
 */
@Injectable()
export class NotificationDispatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  /** 事件面退订句柄 */
  private offs: Array<() => void> = [];

  /**
   * @param transport 事件面（订阅任务 / 队列事件，广播通知事件）
   * @param notifications 通知服务（落库）
   */
  constructor(
    private readonly transport: TransportService,
    private readonly notifications: NotificationService,
  ) {}

  /** 启动期订阅两类事件源（失败降级：不阻塞应用启动） */
  async onApplicationBootstrap(): Promise<void> {
    try {
      this.offs.push(await this.transport.subscribe(JOB_TOPIC, (payload) => void this.onJobEvent(payload as JobEventPayload)));
      this.offs.push(await this.transport.subscribe(QUEUE_TOPIC, (payload) => void this.onQueueAlert(payload as QueueAlertPayload)));
      logger.info('通知派发器已订阅事件面', { topics: [JOB_TOPIC, QUEUE_TOPIC] });
    } catch (error) {
      logger.warn('通知派发器订阅事件面失败，站内信退化为「进入消息中心才可见」', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 停机：退订（幂等） */
  onApplicationShutdown(): void {
    for (const off of this.offs) {
      try {
        off();
      } catch {
        // 退订失败不影响停机
      }
    }
    this.offs = [];
  }

  /**
   * 任务终态事件 → 派发人通知
   *
   * 只处理终态：进度事件频率高（每次 report 一条），落成站内信会瞬间刷满消息中心；
   * 进度感知是任务条（E-12 SSE）的职责，站内信的职责是「你离开页面后结果也找得到」。
   * @param event 任务事件载荷
   */
  async onJobEvent(event: JobEventPayload): Promise<void> {
    if (event?.kind !== 'finished' || !event.job?.id || !event.ownerId) return;
    const { job, ownerId } = event;
    const succeeded = job.status === 'succeeded';
    const row = await this.notifications.create({
      userId: ownerId,
      kind: succeeded ? 'job.finished' : 'job.failed',
      level: succeeded ? 'success' : 'error',
      title: `${succeeded ? '任务完成' : '任务失败'}：${job.title}`,
      content: succeeded
        ? job.fileName
          ? `产物 ${job.fileName} 已可下载`
          : '任务已成功完成'
        : (job.error ?? '执行失败，可在任务条重试'),
      refType: 'job',
      refId: job.id,
      traceId: job.traceId || null,
      dedupeKey: `job:${job.id}:${job.status}:${job.updatedAt}`,
    });
    if (row) this.publishCreated(row);
  }

  /**
   * 队列告警事件 → 持 `system:queue:list` 的账号各一条
   * @param alert 队列告警载荷
   */
  async onQueueAlert(alert: QueueAlertPayload): Promise<void> {
    if (!alert?.kind) return;
    const recipients = await this.notifications.recipientsByPermission(QUEUE_PERM_LIST);
    if (recipients.length === 0) {
      logger.debug('队列告警无收件人（无账号持 system:queue:list），已跳过', { kind: alert.kind });
      return;
    }
    const base =
      alert.kind === 'dead-letter'
        ? {
            kind: 'queue.dead-letter' as const,
            level: 'error' as const,
            title: `队列死信：${alert.jobName ?? alert.jobId ?? '未知任务'}`,
            content: `已重试 ${alert.attemptsMade ?? 0} 次后进入死信：${alert.reason ?? '未知原因'}`,
            refType: 'queue' as const,
            refId: alert.jobId ?? null,
            traceId: null,
            dedupeKey: `queue:dead-letter:${alert.jobId ?? alert.at}`,
          }
        : {
            kind: 'queue.backlog' as const,
            level: 'warning' as const,
            title: '队列积压告警',
            content: `等待任务 ${alert.waiting ?? '-'} 已超过阈值 ${alert.threshold ?? '-'}`,
            refType: 'queue' as const,
            refId: alert.queue ?? null,
            traceId: null,
            dedupeKey: `queue:backlog:${alert.at}`,
          };
    const rows = await this.notifications.broadcast(base, recipients);
    for (const row of rows) this.publishCreated(row);
    if (rows.length > 0) logger.info('队列告警已转为站内信', { kind: alert.kind, recipients: rows.length });
  }

  /** 广播 `notification.created`（SSE 实时未读依赖它） */
  private publishCreated(row: NotificationRow): void {
    const payload: NotificationCreatedPayload = { ownerId: row.userId, notification: toView(row) };
    void this.transport.publish(NOTIFICATION_TOPIC, payload).catch((error: unknown) => {
      logger.warn('通知事件广播失败（消息已落库，进消息中心仍可见）', {
        notificationId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

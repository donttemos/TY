/*
 * @file SSE 实时推送服务（M10 E-12）
 * @description 统一 SSE 通道的服务侧：① 装配两条事件源（任务面 job-events、队列面 queue-alerts）
 *   到 `@fw/transport` 事件面；② 签发 / 核销一次性 SSE 票据（避免把 access token 放进 URL，
 *   票据经 `CACHE_STORE` 存储——redis 驱动下多实例共享，SSE 可落任意实例）；③ 积压巡检
 *   （等宽间隔读队列统计，越过阈值时边沿触发一次 backlog 告警，回落时复位）。
 *
 *   为什么用票据而非 `?token=<access token>`：EventSource 无法自定义请求头，令牌只能进查询串；
 *   查询串会落进网关 / 反代访问日志，等于把长期凭证写进日志。票据是 60s 一次性的短凭证，
 *   泄漏窗口与影响面都小得多（换取 → 立即核销）。
 *
 *   多副本语义（PRD-010 AC9）：发布经 transport 事件面（redis 驱动 = 跨实例扇出），
 *   订阅在任意实例的 SSE 连接都能收到别处产生的事件——不依赖 E-01 的持久层，但与之互补。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-15 donttemo M10 E-13：主题常量迁至 topics.ts 并新增 notification 主题
 *   （站内信实时推送），本文件 re-export 保持既有 import 路径不变
 * @module example-api/events
 */

import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CACHE_STORE, type CacheStorePort } from '@fw/cache';
import { QUEUE_PERM_LIST, QUEUE_SERVICE, type QueueService } from '@fw/queue';
import { Logger } from '@fw/logger';
import { TransportService } from '@fw/transport';
import { PERM, type RequestUser } from '@fw/auth';
import { setJobEventSink, type JobEventPayload } from '../jobs/job-events.js';
import { publishQueueAlert, setQueueAlertSink, type QueueAlertPayload } from './queue-alerts.js';
import { JOB_TOPIC, NOTIFICATION_TOPIC, QUEUE_TOPIC } from './topics.js';

const logger = Logger.for('events');

export { JOB_TOPIC, NOTIFICATION_TOPIC, QUEUE_TOPIC };

/** SSE 票据有效期（秒）：够一次建连即可，过期即废 */
export const SSE_TICKET_TTL_SECONDS = 60;

/** 心跳间隔（毫秒）：必须小于反代 `proxy_read_timeout`（Nginx 默认 60s），否则空闲连接被掐 */
export const SSE_HEARTBEAT_MS = 15_000;

/** 积压巡检间隔（毫秒） */
export const BACKLOG_CHECK_MS = 15_000;

/** 积压告警阈值（等待任务数）：达到即广播 backlog 告警，回落即复位（边沿触发，不刷屏） */
export const BACKLOG_THRESHOLD = 100;

/** 票据键前缀 */
const TICKET_KEY_PREFIX = 'fw:sse:ticket:';

/** 订阅主题名（对外枚举值；与 transport 主题名解耦，前端只认这几个） */
export type SseTopicName = 'job' | 'notification' | 'queue';

/** 票据声明（核销后由 SSE 连接持有） */
export interface SseTicketClaims {
  /** 用户 ID（任务事件的可见性边界） */
  userId: string;
  /** 账号名（日志用） */
  username: string;
  /** 该用户可订阅的主题 */
  topics: SseTopicName[];
}

/** 票据签发结果（`POST /events/ticket` 的 data） */
export interface SseTicket {
  /** 一次性票据 */
  ticket: string;
  /** 有效期（秒） */
  expiresIn: number;
  /** 可订阅主题 */
  topics: SseTopicName[];
}

/**
 * SSE 实时推送服务
 */
@Injectable()
export class EventsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private backlogTimer: ReturnType<typeof setInterval> | undefined;
  /** 上一次是否处于积压告警态（边沿触发） */
  private backlogAlerted = false;

  /**
   * @param transport 事件面（发布 / 订阅）
   * @param queue 队列服务（积压巡检）
   * @param store 票据存储（与限流 / 权限缓存同源，redis 驱动下多实例共享）
   */
  constructor(
    private readonly transport: TransportService,
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
    @Inject(CACHE_STORE) private readonly store: CacheStorePort,
  ) {}

  /** 装配两条事件源 + 启动积压巡检 */
  onApplicationBootstrap(): void {
    setJobEventSink((payload: JobEventPayload) => {
      void this.publish(JOB_TOPIC, payload);
    });
    setQueueAlertSink((payload: QueueAlertPayload) => {
      void this.publish(QUEUE_TOPIC, payload);
    });
    this.backlogTimer = setInterval(() => void this.checkBacklog(), BACKLOG_CHECK_MS);
    // 巡检定时器不阻止进程退出（与 @fw/queue 的内部实现同约定）
    (this.backlogTimer as { unref?: () => void }).unref?.();
    logger.info('SSE 通道已装配', {
      jobTopic: JOB_TOPIC,
      queueTopic: QUEUE_TOPIC,
      heartbeatMs: SSE_HEARTBEAT_MS,
      backlogThreshold: BACKLOG_THRESHOLD,
    });
  }

  /** 解除事件源与巡检（优雅停机） */
  onApplicationShutdown(): void {
    setJobEventSink(undefined);
    setQueueAlertSink(undefined);
    if (this.backlogTimer) {
      clearInterval(this.backlogTimer);
      this.backlogTimer = undefined;
    }
  }

  /**
   * 签发一次性票据
   * @param user 当前登录用户（权限决定可订阅主题）
   * @returns 票据、有效期与可订阅主题
   */
  async issueTicket(user: RequestUser): Promise<SseTicket> {
    const topics = topicsFor(user);
    const claims: SseTicketClaims = { userId: user.id, username: user.username, topics };
    const ticket = randomUUID();
    await this.store.set(ticketKey(ticket), JSON.stringify(claims), SSE_TICKET_TTL_SECONDS * 1000);
    logger.debug('SSE 票据已签发', { userId: user.id, topics });
    return { ticket, expiresIn: SSE_TICKET_TTL_SECONDS, topics };
  }

  /**
   * 核销票据（一次性）：取后即删
   *
   * 并发核销只有一个调用方拿到 `del` 的命中（1），其余拿到 0 并判定票据无效——
   * 用「删除的原子性」代替「读-改-写」的竞态。
   * @param ticket 票据
   * @returns 票据声明；不存在 / 已核销 / 已过期返回 null
   */
  async redeemTicket(ticket: string): Promise<SseTicketClaims | null> {
    if (!ticket) return null;
    const key = ticketKey(ticket);
    const raw = await this.store.get(key);
    if (!raw) return null;
    const removed = await this.store.del([key]);
    if (removed === 0) return null;
    try {
      const claims = JSON.parse(raw) as SseTicketClaims;
      if (!claims?.userId || !Array.isArray(claims.topics)) return null;
      return claims;
    } catch {
      return null;
    }
  }

  /**
   * 发布事件（事件面未装配时记日志并吞掉——推送故障不得影响任务与队列本身）
   * @param topic 主题
   * @param payload 载荷
   */
  async publish(topic: string, payload: unknown): Promise<void> {
    try {
      await this.transport.publish(topic, payload);
    } catch (error) {
      logger.warn('事件发布失败（实时推送降级为前端轮询兜底）', {
        topic,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 订阅主题
   * @param topic 主题（transport 主题名）
   * @param handler 处理器
   * @returns 取消订阅函数
   */
  subscribe(topic: string, handler: (payload: unknown) => void): Promise<() => void> {
    return this.transport.subscribe(topic, (payload) => handler(payload));
  }

  /** 事件面统计（诊断用） */
  eventStats(): ReturnType<TransportService['stats']>['events'] {
    return this.transport.stats().events;
  }

  /**
   * 积压巡检：等待任务数越过阈值时边沿触发一次告警，回落时复位
   *
   * 只在跨阈值的那一刻广播（而不是每轮都发），避免 15s 一次把 SSE 通道刷成噪声源。
   */
  private async checkBacklog(): Promise<void> {
    try {
      const stats = await this.queue.stats();
      const waiting = stats.totals.waiting;
      if (waiting >= BACKLOG_THRESHOLD && !this.backlogAlerted) {
        this.backlogAlerted = true;
        publishQueueAlert({
          kind: 'backlog',
          at: new Date().toISOString(),
          waiting,
          threshold: BACKLOG_THRESHOLD,
        });
        logger.warn('队列积压超过阈值', { waiting, threshold: BACKLOG_THRESHOLD });
      } else if (waiting < BACKLOG_THRESHOLD && this.backlogAlerted) {
        this.backlogAlerted = false;
        logger.info('队列积压已回落至阈值以下', { waiting });
      }
    } catch (error) {
      // 巡检失败（驱动不可用等）只记日志，不打断后续巡检
      logger.debug('积压巡检失败', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * 用户可订阅主题
 *
 * `job`（任务事件）人人可用——任务面的语义是「我自己的执行产物」；
 * `notification`（站内信）需 `notification:read`；`queue`（队列告警）需 `system:queue:list`。
 * 主题按权限裁剪而非「连上再过滤」：不该看到的主题根本不订阅，服务端与客户端都少一份数据流。
 */
function topicsFor(user: RequestUser): SseTopicName[] {
  const topics: SseTopicName[] = ['job'];
  if (user.permissions?.includes(PERM.NOTIFICATION_READ)) topics.push('notification');
  if (user.permissions?.includes(QUEUE_PERM_LIST)) topics.push('queue');
  return topics;
}

/** 票据键 */
function ticketKey(ticket: string): string {
  return `${TICKET_KEY_PREFIX}${ticket}`;
}

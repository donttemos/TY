/*
 * @file SSE 实时推送端点（M10 E-12）
 * @description 统一 SSE 通道的两个端点：
 *   - `POST /api/v1/events/ticket`（登录即可）——签发 60s 一次性票据，主题按权限裁剪
 *     （任务面人人可用；队列面需 `system:queue:list`）；
 *   - `GET /api/v1/events/stream?ticket=...`（`@Public` + 手动核销票据）——建立
 *     `text/event-stream` 长连接，下发 `job` / `queue` 两类事件，15s 心跳保活。
 *
 *   鉴权为何不走统一守卫：EventSource 无法自定义请求头，令牌/票据只能进查询串；
 *   票据是一次性短凭证（60s、取后即废），泄漏面远小于把 access token 放进 URL。
 *   `@Public()` 让守卫放行，控制器内先核销票据再开流——票据核销失败直接 3001，不开流。
 *
 *   事件名（SSE `event:` 字段）：`job` = 任务事件、`notification` = 站内信（E-13）、
 *   `queue` = 队列告警、`ready` = 建连确认。
 *   响应不加统一信封（`text/event-stream` 是流协议，见 jobs 下载端点同款约定）。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-15 donttemo M10 E-13：新增 `notification` 事件（站内信实时未读），
 *   同样按 ownerId 过滤；票据主题裁剪同步（无 `notification:read` 不订阅该主题）
 * @module example-api/events
 */

import { Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { CurrentUser, Public, type RequestUser } from '@fw/auth';
import { Logger } from '@fw/logger';
import type { Request, Response } from 'express';
import { EventsService, JOB_TOPIC, NOTIFICATION_TOPIC, QUEUE_TOPIC, SSE_HEARTBEAT_MS, type SseTicket } from './events.service.js';
import type { JobEventPayload } from '../jobs/job-events.js';
import type { NotificationCreatedPayload } from '../notifications/notification-dispatcher.js';
import type { QueueAlertPayload } from './queue-alerts.js';

const logger = Logger.for('events');

/**
 * SSE 控制器：/api/v1/events
 */
@Controller('/api/v1/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** 签发一次性票据（200 而非 201：取票语义，不是新建资源） */
  @Post('ticket')
  @HttpCode(HttpStatus.OK)
  async ticket(@CurrentUser() user: RequestUser): Promise<SseTicket> {
    if (!user?.id) throw new BizError(ErrorCode.UNAUTHORIZED, '未登录或令牌无效');
    return this.events.issueTicket(user);
  }

  /**
   * 事件流（SSE）
   *
   * 建连流程：核销票据 → 写响应头 → 发 `ready` → 订阅授权主题 → 心跳保活；
   * 客户端断开（`req.close`）时退订并清心跳，不留悬挂订阅（连接数无界增长的根因）。
   *
   * @param ticket 票据
   * @param req 原始请求（监听 close）
   * @param res 原始响应（直接写流，不经统一信封）
   */
  @Get('stream')
  @Public()
  async stream(
    @Query('ticket') ticket: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const claims = await this.events.redeemTicket(ticket ?? '');
    if (!claims) throw new BizError(ErrorCode.UNAUTHORIZED, 'SSE 票据无效或已过期，请刷新页面重试');

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 反代（Nginx）默认会缓冲响应体，缓冲后事件不再实时到达——显式关闭缓冲
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    writeFrame(res, 'ready', { topics: claims.topics, heartbeatMs: SSE_HEARTBEAT_MS });

    const unsubscribers: Array<() => void> = [];
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      for (const off of unsubscribers) {
        try {
          off();
        } catch {
          // 退订失败不影响其余退订
        }
      }
    };

    try {
      if (claims.topics.includes('job')) {
        const off = await this.events.subscribe(JOB_TOPIC, (payload) => {
          const event = payload as JobEventPayload;
          // 可见性边界：任务事件只推给归属人（同一主题下服务端过滤，不靠前端自觉）
          if (!event || event.ownerId !== claims.userId) return;
          writeFrame(res, 'job', event);
        });
        unsubscribers.push(off);
      }
      if (claims.topics.includes('notification')) {
        const off = await this.events.subscribe(NOTIFICATION_TOPIC, (payload) => {
          const event = payload as NotificationCreatedPayload;
          // 站内信同样按归属人过滤（消息是私有的，不能靠前端「只渲染自己的」）
          if (!event || event.ownerId !== claims.userId) return;
          writeFrame(res, 'notification', event);
        });
        unsubscribers.push(off);
      }
      if (claims.topics.includes('queue')) {
        const off = await this.events.subscribe(QUEUE_TOPIC, (payload) => {
          writeFrame(res, 'queue', payload as QueueAlertPayload);
        });
        unsubscribers.push(off);
      }
    } catch (error) {
      cleanup();
      throw new BizError(ErrorCode.INTERNAL, `事件通道不可用：${error instanceof Error ? error.message : String(error)}`);
    }

    heartbeat = setInterval(() => {
      // 注释帧（`: ...`）不触发客户端事件，仅用于保活与探活日志
      safeWrite(res, ': heartbeat\n\n');
    }, SSE_HEARTBEAT_MS);

    req.on('close', () => {
      cleanup();
      logger.debug('SSE 连接已断开，订阅已释放', { userId: claims.userId, topics: claims.topics });
    });

    logger.debug('SSE 连接已建立', { userId: claims.userId, topics: claims.topics });
  }
}

/** 写一帧 SSE 事件（data 用 JSON；JSON 串不含裸换行，无需多行拼接） */
function writeFrame(res: Response, event: string, payload: unknown): void {
  safeWrite(res, `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** 安全写流：连接已结束（客户端断开与写竞争）时静默丢弃 */
function safeWrite(res: Response, chunk: string): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(chunk);
  } catch {
    // 写失败（连接被重置）由 close 事件做清理，此处不抛
  }
}

/*
 * @file 站内信端点（M10 E-13）
 * @description 通知中心的用户面：分页列表（含未读数）、未读数、标记已读、全部已读、删除。
 *   鉴权：`notification:read`（与审计 / 任务面同构的显式权限码——消息中心是全局可达能力，
 *   但「谁能看消息中心」仍需可授予、可回收，故不落「登录即可」）。
 *   **归属人即边界**：全部端点只操作本人消息，越权一律 `404`（不泄露存在性，与 `/jobs/:id/*` 同语义）。
 *   列表参数按 api-spec §1.5 约定钳制（pageSize 上限 200，越界收敛而非报错）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/notifications
 */

import { Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Permissions, PERM } from '@fw/auth';
import { NotificationService, type NotificationView } from './notification.service.js';

/** 列表响应 */
export interface NotificationListResponse {
  /** 过滤条件下的总数 */
  total: number;
  /** 未读总数（与 unread-count 同源，供铃铛与列表页共用一次请求） */
  unread: number;
  /** 本页明细 */
  items: NotificationView[];
  page: number;
  pageSize: number;
}

/**
 * 站内信控制器：/api/v1/notifications
 */
@Controller('/api/v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  /**
   * 本人消息分页
   * @param userId 当前用户
   * @param page 页码（从 1 开始）
   * @param pageSize 每页条数（上限 200）
   * @param unreadOnly 仅未读（`'true'`）
   */
  @Get()
  @Permissions(PERM.NOTIFICATION_READ)
  async list(
    @CurrentUser('id') userId: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('unreadOnly') unreadOnly = 'false',
  ): Promise<NotificationListResponse> {
    return this.notifications.list(userId, { page: Number(page), pageSize: Number(pageSize), unreadOnly: unreadOnly === 'true' });
  }

  /** 未读数（铃铛角标；高频轮询兜底路径的轻量端点） */
  @Get('unread-count')
  @Permissions(PERM.NOTIFICATION_READ)
  async unreadCount(@CurrentUser('id') userId: string): Promise<{ unread: number }> {
    return { unread: await this.notifications.unreadCount(userId) };
  }

  /**
   * 标记单条已读（幂等）
   * @param id 通知 ID
   * @param userId 当前用户
   */
  @Post(':id/read')
  @Permissions(PERM.NOTIFICATION_READ)
  async read(@Param('id') id: string, @CurrentUser('id') userId: string): Promise<NotificationView> {
    return this.notifications.markRead(id, userId);
  }

  /** 全部标记已读 */
  @Post('read-all')
  @Permissions(PERM.NOTIFICATION_READ)
  async readAll(@CurrentUser('id') userId: string): Promise<{ updated: number }> {
    return { updated: await this.notifications.markAllRead(userId) };
  }

  /**
   * 删除本人消息
   * @param id 通知 ID
   * @param userId 当前用户
   */
  @Delete(':id')
  @Permissions(PERM.NOTIFICATION_READ)
  async remove(@Param('id') id: string, @CurrentUser('id') userId: string): Promise<{ id: string; removed: true }> {
    await this.notifications.remove(id, userId);
    return { id, removed: true };
  }
}

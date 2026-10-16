/*
 * @file 站内信模块（M10 E-13）
 * @description 通知中心装配：持久层（Prisma，`notifications` 表）+ 服务 + 事件订阅派发器 + 用户面端点。
 *   `DB_CLIENT` 由全局 DbModule 提供（与 JobsModule 同约定，无需显式 imports）。
 *   派发器在启动期订阅 `@fw/transport` 事件面——**站内信是事件的消费者而非任务/队列的调用方**，
 *   因此模块间没有直接代码依赖（只有主题名与载荷类型）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/notifications
 */

import { Module, type Provider } from '@nestjs/common';
import { DB_CLIENT, type PrismaClientLike } from '@fw/db';
import { NotificationDispatcher } from './notification-dispatcher.js';
import { NotificationService } from './notification.service.js';
import { PrismaNotificationStore, type NotificationStore } from './notification.store.js';
import { NOTIFICATION_STORE } from './notification.tokens.js';
import { NotificationsController } from './notifications.controller.js';

/**
 * 站内信模块
 */
@Module({
  providers: [
    {
      provide: NOTIFICATION_STORE,
      useFactory: (client: PrismaClientLike): NotificationStore => new PrismaNotificationStore(client),
      inject: [DB_CLIENT],
    },
    NotificationService,
    NotificationDispatcher,
  ] as Provider[],
  controllers: [NotificationsController],
  exports: [NotificationService],
})
export class NotificationsModule {}

/*
 * @file 管理后台模块（admin 模板）
 * @description 菜单维护与字典端点 + ADMIN_STORE 存储端口（PrismaAdminStore）。
 *   用户 / 角色 / 审计控制器在 AppAuthModule 中注册（与鉴权守卫同面），本模块导出 ADMIN_STORE 供注入。
 * @author donttemo
 * @created 2026-10-15
 * @module __APP_NAME__/admin
 */
import { Module } from '@nestjs/common';
import { ADMIN_STORE, PrismaAdminStore } from './admin-store.js';
import { DictController } from './dict.controller.js';
import { MenusController } from './menus.controller.js';

/**
 * 管理后台模块
 */
@Module({
  controllers: [MenusController, DictController],
  providers: [{ provide: ADMIN_STORE, useClass: PrismaAdminStore }],
  exports: [ADMIN_STORE],
})
export class AdminStoreModule {}

/*
 * @file 鉴权模块装配（example-api）
 * @description 以类形态传入 PrismaAuthStore，由 Nest 注入 DbModule（全局）提供的插桩 PrismaClient；
 *   缓存以类形态传入 CacheBackedAuthCache（M4：把 @fw/cache 的 CacheService 适配为 AuthCachePort，
 *   权限缓存/黑名单/登录限流随之共享到 Redis，多实例一致）；注册认证 / 用户 / 角色权限 / 审计四组控制器。
 *   全局守卫与审计拦截器由 @fw/auth 的 AuthModule 注册。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 接入 CacheService 适配器（M3 遗留项②：权限缓存换 Redis）
 * @module example-api/auth
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '@fw/auth';
import { AuditController } from './audit.controller.js';
import { AuthController } from './auth.controller.js';
import { CacheBackedAuthCache } from './cache-backed-auth-cache.js';
import { PrismaAuthStore } from './prisma-auth-store.js';
import { RbacController } from './rbac.controller.js';
import { UsersController } from './users.controller.js';

/**
 * 应用鉴权模块：M3 验收载体
 */
@Module({
  imports: [AuthModule.forRoot({ store: PrismaAuthStore, cache: CacheBackedAuthCache })],
  controllers: [AuthController, UsersController, RbacController, AuditController],
})
export class AppAuthModule {}

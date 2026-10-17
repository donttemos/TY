/*
 * @file 鉴权模块装配（admin 模板）
 * @description 以类形态传入 PrismaAuthStore（Nest 注入 DbModule 全局提供的插桩 PrismaClient）；
 *   缓存以类形态传入 CacheBackedAuthCache（@fw/cache 的 CacheService 适配为 AuthCachePort，
 *   CACHE_DRIVER=redis 时权限缓存 / 黑名单 / 登录限流多实例一致）。全局守卫与审计拦截器
 *   由 @fw/auth 的 AuthModule 注册。组织解析端口（DATA_SCOPE_ORG）与 AuthStore 同实现复用。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-02）：裸抛迁移至 BizError 统一码（ADR-0025 三类治理）
 * @module __APP_NAME__/auth
 */
import { Module } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { AuthModule, AUTH_STORE, DATA_SCOPE_ORG } from '@fw/auth';
import type { AuthStore, DataScopeOrgPort } from '@fw/auth';
import { ADMIN_STORE, PrismaAdminStore } from '../admin/admin-store.js';
import { AdminStoreModule } from '../admin/admin.module.js';
import { AuditController } from './audit.controller.js';
import { AuthController } from './auth.controller.js';
import { CacheBackedAuthCache } from './cache-backed-auth-cache.js';
import { PrismaAuthStore } from './prisma-auth-store.js';
import { RbacController } from './rbac.controller.js';
import { UsersController } from './users.controller.js';

/**
 * 应用鉴权模块：登录 + RBAC + 审计端点
 */
@Module({
  imports: [
    AuthModule.forRoot({ store: PrismaAuthStore, cache: CacheBackedAuthCache }),
    // 管理后台存储端口（用户软删 / 角色维护 / 菜单维护 / 审计详情 / 字典）——auth 控制器注入 ADMIN_STORE
    AdminStoreModule,
  ],
  controllers: [AuthController, UsersController, RbacController, AuditController],
  providers: [
    // 组织解析端口与 AuthStore 同实现（PrismaAuthStore），经 AUTH_STORE 适配注册，
    // 避免 useExisting 造成二次实例化；存储缺部门能力时启动即失败（fail-fast）
    {
      provide: DATA_SCOPE_ORG,
      useFactory: (store: AuthStore): DataScopeOrgPort => {
        const candidate = store as Partial<DataScopeOrgPort>;
        if (typeof candidate.listVisibleDepartmentIds !== 'function' || typeof candidate.listUserIdsByDepartmentIds !== 'function') {
          throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, 'AUTH_STORE 未实现 DataScopeOrgPort：org / org_below 数据范围不可用（需 departments / user_department 查询能力）');
        }
        // 运行时已校验方法存在；两接口无继承关系，需经 unknown 双重断言
        return store as unknown as DataScopeOrgPort;
      },
      inject: [AUTH_STORE],
    },
  ],
})
export class AppAuthModule {}

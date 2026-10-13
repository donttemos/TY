/*
 * @file 鉴权模块装配（example-api）
 * @description 以类形态传入 PrismaAuthStore，由 Nest 注入 DbModule（全局）提供的插桩 PrismaClient；
 *   缓存以类形态传入 CacheBackedAuthCache（M4：把 @fw/cache 的 CacheService 适配为 AuthCachePort，
 *   权限缓存/黑名单/登录限流随之共享到 Redis，多实例一致）；注册认证 / 用户 / 角色权限 / 审计四组控制器。
 *   全局守卫与审计拦截器由 @fw/auth 的 AuthModule 注册。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 接入 CacheService 适配器（M3 遗留项②：权限缓存换 Redis）
 * @modified 2026-10-13 donttemo 接入 AuthMaintenanceJobs（M3 遗留项④：refresh 过期记录定时清理）
 * @modified 2026-10-14 donttemo M8 T-M8-04：注册 DATA_SCOPE_ORG 组织解析端口（org / org_below 数据范围）
 * @module example-api/auth
 */

import { Module } from '@nestjs/common';
import { AuthModule, AUTH_STORE, DATA_SCOPE_ORG } from '@fw/auth';
import type { AuthStore, DataScopeOrgPort } from '@fw/auth';
import { AuditController } from './audit.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthMaintenanceJobs } from './auth-maintenance.js';
import { CacheBackedAuthCache } from './cache-backed-auth-cache.js';
import { MaintenanceController } from './maintenance.controller.js';
import { PrismaAuthStore } from './prisma-auth-store.js';
import { RbacController } from './rbac.controller.js';
import { UsersController } from './users.controller.js';

/**
 * 应用鉴权模块：M3 验收载体
 */
@Module({
  imports: [AuthModule.forRoot({ store: PrismaAuthStore, cache: CacheBackedAuthCache })],
  controllers: [AuthController, UsersController, RbacController, AuditController, MaintenanceController],
  providers: [
    AuthMaintenanceJobs,
    // M8 T-M8-04：组织解析端口与 AuthStore 同实现（PrismaAuthStore），经 AUTH_STORE 适配注册，
    // 避免 useExisting 造成二次实例化；存储缺部门能力时启动即失败（fail-fast），不留运行期 500
    {
      provide: DATA_SCOPE_ORG,
      useFactory: (store: AuthStore): DataScopeOrgPort => {
        const candidate = store as Partial<DataScopeOrgPort>;
        if (typeof candidate.listVisibleDepartmentIds !== 'function' || typeof candidate.listUserIdsByDepartmentIds !== 'function') {
          throw new Error('AUTH_STORE 未实现 DataScopeOrgPort：org / org_below 数据范围不可用（需 departments / user_department 查询能力）');
        }
        // 运行时已校验方法存在；两接口无继承关系，需经 unknown 双重断言
        return store as unknown as DataScopeOrgPort;
      },
      inject: [AUTH_STORE],
    },
  ],
})
export class AppAuthModule {}

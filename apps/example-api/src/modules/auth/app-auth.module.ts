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
 * @modified 2026-10-15 donttemo E-07：注册 OAuth2Controller（providers / authorize / callback 三端点，
 *   授权码流服务 AUTH_OAUTH2_FLOW 由 @fw/auth 的 AuthModule 装配并导出，应用只写控制器与身份映射）
 * @modified 2026-10-15 donttemo E-10：装配审计归档——PrismaAuditArchiveStore（AuditArchivePort 的
 *   Prisma 适配）+ AuditArchiveService + AuditArchiveJobs（@Cron audit.archive，分布式锁多副本单执行）
 *   + AuditArchiveController（归档查询/导出两端点）
 * @module example-api/auth
 */

import { Module } from '@nestjs/common';
import { AuthModule, AUTH_STORE, DATA_SCOPE_ORG, AuditArchiveService } from '@fw/auth';
import type { AuthStore, DataScopeOrgPort } from '@fw/auth';
import { ADMIN_STORE, PrismaAdminStore } from '../admin/admin-store.js';
import { DictController } from '../admin/dict.controller.js';
import { MenusController } from '../admin/menus.controller.js';
import { AuditArchiveController } from './audit-archive.controller.js';
import { AuditArchiveJobs } from './audit-archive.jobs.js';
import { PrismaAuditArchiveStore } from './audit-archive-store.js';
import { AuditController } from './audit.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthMaintenanceJobs } from './auth-maintenance.js';
import { CacheBackedAuthCache } from './cache-backed-auth-cache.js';
import { MaintenanceController } from './maintenance.controller.js';
import { OAuth2Controller } from './oauth2.controller.js';
import { PrismaAuthStore } from './prisma-auth-store.js';
import { RbacController } from './rbac.controller.js';
import { UsersController } from './users.controller.js';

/**
 * 应用鉴权模块：M3 验收载体
 */
@Module({
  imports: [AuthModule.forRoot({ store: PrismaAuthStore, cache: CacheBackedAuthCache })],
  controllers: [
    AuthController,
    UsersController,
    RbacController,
    AuditController,
    // E-10：审计归档查询 / 导出（冷数据出口，数据范围与在线审计同源收敛）
    AuditArchiveController,
    MaintenanceController,
    // E-07：OAuth2 授权码端到端（providers / authorize / callback；流服务由 AuthModule 装配导出）
    OAuth2Controller,
    // C-06 契约 §3.5 / §3.6：菜单维护与字典（M5 前端按契约全量实现，M3 后端未落地，接入真实 API 后 404）
    MenusController,
    DictController,
  ],
  providers: [
    AuthMaintenanceJobs,
    // E-10：审计归档链路——Prisma 适配（AuditArchivePort）→ 归档服务（先写归档后删在线）→ cron 载体
    PrismaAuditArchiveStore,
    {
      provide: AuditArchiveService,
      useFactory: (store: PrismaAuditArchiveStore): AuditArchiveService => new AuditArchiveService(store),
      inject: [PrismaAuditArchiveStore],
    },
    AuditArchiveJobs,
    // 管理后台存储端口：用户软删 / 角色维护 / 菜单维护 / 登录设备 / 审计详情 / 字典
    { provide: ADMIN_STORE, useClass: PrismaAdminStore },
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

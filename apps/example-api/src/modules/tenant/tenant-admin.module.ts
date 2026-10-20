/*
 * @file 租户管理模块（N-01）
 * @description 注册租户管理端点与其存储端口实现。与 @fw/tenant 的 TenantModule（运行时解析，只读）
 *   分离：管理面的写能力全部落在本模块，框架包契约零改动。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-21 donttemo P0 收口：导入 SaasModule 注入 TenantLifecycleService（状态写权收口）
 * @module example-api/tenant
 */

import { Module } from '@nestjs/common';
import { SaasModule } from '../saas/saas.module.js';
import { TenantAdminController } from './tenant-admin.controller.js';
import { PrismaTenantAdminStore, TENANT_ADMIN_STORE } from './tenant-admin.store.js';

/**
 * 租户管理模块（imports SaasModule 以取得 TenantLifecycleService：
 * `tenants.status` 的写权唯一归属状态机，ADR-0031 §2.3）
 */
@Module({
  imports: [SaasModule],
  controllers: [TenantAdminController],
  providers: [{ provide: TENANT_ADMIN_STORE, useClass: PrismaTenantAdminStore }],
})
export class TenantAdminModule {}

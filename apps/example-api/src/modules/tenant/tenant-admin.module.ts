/*
 * @file 租户管理模块（N-01）
 * @description 注册租户管理端点与其存储端口实现。与 @fw/tenant 的 TenantModule（运行时解析，只读）
 *   分离：管理面的写能力全部落在本模块，框架包契约零改动。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/tenant
 */

import { Module } from '@nestjs/common';
import { TenantAdminController } from './tenant-admin.controller.js';
import { PrismaTenantAdminStore, TENANT_ADMIN_STORE } from './tenant-admin.store.js';

/**
 * 租户管理模块
 */
@Module({
  controllers: [TenantAdminController],
  providers: [{ provide: TENANT_ADMIN_STORE, useClass: PrismaTenantAdminStore }],
})
export class TenantAdminModule {}

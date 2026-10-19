/*
 * @file 生命周期豁免装饰器
 * @description M13（ADR-0031 §3.2）：`@LifecycleExempt()` 标注在控制器类/方法上，
 *   冻结/终止拦截（SaasLifecycleGuard 4031）对该路由放行。**默认拒绝**：业务路由不标注即受拦截，
 *   豁免点清单入检查（运营面/导出/登录等白名单能力），防止业务代码随手豁免。
 * @author donttemo
 * @created 2026-10-19
 * @module example-api/saas
 */
import { SetMetadata } from '@nestjs/common';

/** 豁免元数据键 */
export const META_LIFECYCLE_EXEMPT = 'fw:saas:lifecycle-exempt';

/** 冻结/终止拦截豁免（仅白名单能力：管理端登录、数据导出、生命周期/账单查询等） */
export const LifecycleExempt = (): MethodDecorator & ClassDecorator => SetMetadata(META_LIFECYCLE_EXEMPT, true);

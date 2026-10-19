/*
 * @file SaaS 模块 DI token
 * @description SaasStore 端口绑定 token（saas.module 装配，控制器/任务/Guard 消费）。
 * @author donttemo
 * @created 2026-10-19
 * @module example-api/saas
 */

/** SaaS 存储端口 token（不感知 Prisma 细节） */
export const SAAS_STORE = Symbol('SAAS_STORE');

/** 宽限期天数配置键（SAAS_GRACE_PERIOD_DAYS，默认 7，ADR-0031 §4） */
export const SAAS_GRACE_PERIOD_DAYS = 'SAAS_GRACE_PERIOD_DAYS';

/** 宽限期默认值 */
export const DEFAULT_GRACE_PERIOD_DAYS = 7;

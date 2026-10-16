/*
 * @file 站内信依赖令牌（M10 E-13）
 * @description 模块装配用令牌：存储端口、事件主题。放在独立文件避免
 *   「service ↔ module」相互引用（与 jobs 模块的 JOB_STORE_TOKEN 同约定）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/notifications
 */

/** 站内信存储端口令牌 */
export const NOTIFICATION_STORE = Symbol('FW_NOTIFICATION_STORE');

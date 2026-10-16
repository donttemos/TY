/*
 * @file 英文文案表（en-US）
 * @description E-14 i18n 骨架：键集与 zh-CN.ts 编译期同构（MessageSchema 强类型，缺键即编译失败）；
 *   错误码语义对照 docs/40-api-spec.md §2。骨架阶段仅覆盖错误码与语言切换器，页面文案按需分批迁移（非目标：全覆盖）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/locales
 */

import type { MessageSchema } from './index';

/** 英文文案（errors 键 = 错误码数值；标签类键保留中文语义对照） */
export const enUS: MessageSchema = {
  common: {
    language: 'Language',
    switchLanguage: 'Switch language',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeAuto: 'Follow system',
  },
  errors: {
    1001: 'Invalid request parameters',
    1002: 'Resource not found or has been deleted',
    1003: 'Data conflict: please check unique constraints',
    1004: 'The current state does not allow this operation; refresh and try again',
    2001: 'Business validation failed',
    3001: 'Your session is no longer valid. Please sign in again',
    3002: 'You do not have permission to perform this action',
    3003: 'Your session has expired. Please sign in again',
    3004: 'This account is locked or disabled. Please contact the administrator',
    4001: 'The tenant is invalid or expired',
    5001: 'This config key cannot be hot-updated (boot key or not in the whitelist)',
    5002: 'Invalid config value. Please check and try again',
    '5002Details': 'Invalid config value: {details}',
    5003: 'Config key not found',
    9001: 'Something went wrong. Please try again later',
    '9001Trace': 'Something went wrong (reported, traceId: {traceId})',
    9002: 'A dependency is temporarily unavailable. Please try again later',
    9003: 'Too many requests. Please slow down and try again later',
    fallback: 'Request failed. Please try again later',
  },
};

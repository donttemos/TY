/*
 * @file 中文文案表（zh-CN，缺省语言与缺 key 回落源）
 * @description E-14 i18n 骨架（PRD-010 / ADR-0014）：错误码文案由前端接管（OQ-4 决策：后端只回码不回文案，
 *   映射随构建分发）。errors 段键集与 utils/biz-error.ts BIZ_CODE 编译期同构——新增错误码必须同步本表
 *   与 en-US.ts（docs/40-api-spec.md §2 同源）；文案与 @fw/core ERROR_CODE_META 语义对齐但保留前端既有口径。
 *   模板键约定：9001Trace = 9001 带 traceId 变体；5002Details = 5002 带 details 拼接变体；fallback = 未知码兜底。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/locales
 */

import type { MessageSchema } from './index';

/** 中文文案（errors 键 = 错误码数值） */
export const zhCN: MessageSchema = {
  common: {
    language: '语言',
    switchLanguage: '切换语言',
    theme: '主题',
    themeLight: '浅色',
    themeDark: '暗色',
    themeAuto: '跟随系统',
  },
  errors: {
    1001: '请求参数有误',
    1002: '资源不存在或已删除',
    1003: '数据冲突，请检查唯一性约束',
    1004: '当前状态不允许该操作，请刷新后重试',
    2001: '业务校验未通过',
    3001: '登录状态已失效，请重新登录',
    3002: '无操作权限',
    3003: '登录状态已过期，请重新登录',
    3004: '账号已锁定或禁用，请联系管理员',
    4001: '租户无效或已过期',
    4029: '配额已达上限，请升级套餐或稍后重试',
    4030: '生命周期状态不允许该操作，请刷新后查看当前状态',
    4031: '租户已冻结或终止，请联系平台运营',
    5001: '该配置键不可热更新（boot 键或不在白名单）',
    5002: '新值非法，请检查后重试',
    '5002Details': '新值非法：{details}',
    5003: '配置键不存在',
    9001: '系统开小差了，请稍后重试',
    '9001Trace': '系统开小差了（已上报，traceId：{traceId}）',
    9002: '依赖服务暂不可用，请稍后重试',
    9003: '操作过于频繁，请稍后重试',
    fallback: '请求失败，请稍后重试',
  },
};

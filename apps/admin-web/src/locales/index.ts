/*
 * @file locale 注册表与极简 i18n 运行时（E-14 骨架）
 * @description zh-CN / en-US 双表 + 自研 t() 运行时，不引 vue-i18n（决策见 ADR-0014：骨架阶段避免
 *   为 2 门语言引入运行时依赖与编译管线）。当前 locale 为模块级响应式状态而非 Pinia store：
 *   request / biz-error 等纯 util（无组件与 Pinia 上下文）也要读，避免单测强依赖 Pinia 装配。
 *   初始化顺序：localStorage（fw_admin_locale）→ 缺省 zh-CN；刻意不做浏览器语言嗅探（行为可预测，
 *   嗅探留待后续增强）。zh-CN 为权威表：任一 locale 缺 key 编译期即报错（MessageSchema 强类型），
 *   运行时 translate 再以 zh-CN 兜底。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/locales
 */

import { ref } from 'vue';
import type { BizCodeValue } from '@/utils/biz-error';
import { zhCN } from './zh-CN';
import { enUS } from './en-US';

/** 受支持语言（新增语言 = 加表 + 加此处，t() 与存储值自动覆盖） */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** 缺省语言（不做浏览器嗅探，见文件头） */
export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** locale 持久化键（与 fw_admin_appearance / fw_admin_tags:<uid> 同族命名） */
const STORAGE_KEY = 'fw_admin_locale';

/**
 * 错误码文案表类型：键集与 utils/biz-error.ts BIZ_CODE 数值全集编译期同构
 * （新增错误码未同步两表即 vue-tsc 报错，承接 docs/40-api-spec.md §2「新增错误码必须同步」的前端侧义务）。
 * 变体键：9001Trace（9001 带 traceId 模板）、5002Details（5002 带 details 拼接模板）、fallback（未知码兜底）。
 */
export type ErrorMessages = Record<BizCodeValue, string> & { '9001Trace': string; '5002Details': string; fallback: string };

/** 文案表结构（common 段放界面通用短文案：语言与主题切换器） */
export interface MessageSchema {
  common: {
    language: string;
    switchLanguage: string;
    /** E-15 主题模式三态文案（浅色 / 暗色 / 跟随系统） */
    theme: string;
    themeLight: string;
    themeDark: string;
    themeAuto: string;
  };
  errors: ErrorMessages;
}

export const messages: Record<Locale, MessageSchema> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

/** 语言切换器选项：label/short 用语言原生名（业界惯例：不随当前界面语言翻译） */
export const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string; short: string }> = [
  { value: 'zh-CN', label: '简体中文', short: '中文' },
  { value: 'en-US', label: 'English', short: 'EN' },
];

/** 任意输入归一化为受支持 locale：非法/缺省回落 zh-CN */
export function resolveLocale(input: string | null | undefined): Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(input ?? '') ? (input as Locale) : DEFAULT_LOCALE;
}

/** 点路径取值（'errors.9001' → 文案）：结构缺失返回 null */
function lookup(table: MessageSchema, key: string): string | null {
  const value = key.split('.').reduce<unknown>((node, seg) => {
    return node != null && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined;
  }, table);
  return typeof value === 'string' ? value : null;
}

/** {var} 占位符插值：无对应变量的占位符保留原文（便于发现遗漏） */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => vars[name] ?? placeholder);
}

/** 点路径取文案：当前 locale 缺 key 回落 zh-CN 权威表，仍缺返回 null */
export function translate(locale: Locale, key: string, vars?: Record<string, string>): string | null {
  const raw = lookup(messages[locale], key) ?? lookup(messages[DEFAULT_LOCALE], key);
  if (raw === null) return null;
  return vars ? interpolate(raw, vars) : raw;
}

/** 初始化：localStorage → 缺省 zh-CN（读取失败按缺省处理，不抛错） */
function loadLocale(): Locale {
  try {
    return resolveLocale(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE;
  }
}

const current = ref<Locale>(loadLocale());

/** 当前 locale（响应式读取入口；utils 层无组件上下文也可直接调用） */
export function currentLocale(): Locale {
  return current.value;
}

/** 切换 locale：归一化 + 持久化 + 同步 <html lang>（持久化失败不影响当前会话） */
export function setLocale(locale: string): void {
  const next = resolveLocale(locale);
  current.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 隐私模式等持久化失败：仅当前会话生效
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next;
  }
}

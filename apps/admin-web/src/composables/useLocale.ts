/*
 * @file locale 组合式入口（E-14 i18n 骨架）
 * @description 组件侧使用：当前语言（computed）、切换、t()（缺 key 回落键名本身）与 Element Plus locale
 *   对象——ElConfigProvider 经 App.vue 接线，切换语言即时生效无需刷新（模块级响应式状态，见 src/locales/index.ts）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/composables
 */

import { computed } from 'vue';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import en from 'element-plus/es/locale/lang/en';
import {
  currentLocale,
  LOCALE_OPTIONS,
  setLocale as setGlobalLocale,
  translate,
  type Locale,
} from '@/locales';

/** 组件用 t()：缺 key（回落 zh-CN 后仍缺）返回键名本身，便于肉眼发现遗漏 */
function t(key: string, vars?: Record<string, string>): string {
  const text = translate(currentLocale(), key);
  if (text === null) return key;
  return vars ? text.replace(/\{(\w+)\}/g, (placeholder, name: string) => vars[name] ?? placeholder) : text;
}

/** Element Plus locale 对象（日期选择器 / 分页 / 弹窗等内置文案语言） */
function elementPlusLocale(locale: Locale) {
  return locale === 'zh-CN' ? zhCn : en;
}

/** locale 组合式入口（errorText 供需要按错误码直查文案的场景） */
export function useLocale() {
  const locale = computed<Locale>(() => currentLocale());
  const elLocale = computed(() => elementPlusLocale(currentLocale()));
  const shortLabel = computed(() => LOCALE_OPTIONS.find((item) => item.value === currentLocale())?.short ?? currentLocale());

  return {
    locale,
    elLocale,
    shortLabel,
    options: LOCALE_OPTIONS,
    t,
    setLocale: setGlobalLocale,
  };
}

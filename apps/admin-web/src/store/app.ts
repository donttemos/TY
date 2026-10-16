/*
 * @file 应用外观状态store（Pinia）
 * @description 布局与主题（PRD-005 FR-02 / PRD-010 E-15）：侧边栏折叠、主题模式三态（浅色 / 暗色 / 跟随系统）、
 *   紧凑模式、主色；用户偏好持久化到 localStorage，刷新后恢复。主题通过 CSS 变量覆盖 Element Plus 令牌，
 *   业务组件不写死颜色（docs/25-ui-prototype.md §2）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-16 donttemo M10/E-15 暗色模式收口：
 *   ① 主题三态 themeMode（light / dark / auto）——auto 跟随 prefers-color-scheme 并监听其变更（系统切换即时
 *      生效，无需刷新）；darkMode 降为**生效值派生字段**，不落盘（落盘的是用户意图）；
 *   ② 持久化兼容：旧版仅有 `darkMode` 布尔（无 themeMode）时按「显式 light/dark」迁移——升级后视觉与旧版
 *      一致（零回归），不会因新增 auto 默认把老用户切到跟随系统；无任何持久化（新用户）才默认 auto；
 *   ③ 主色派生口径按主题分流：暗色下浅色系向黑混色、dark-2 向白提亮（原实现两种模式一律向白混色，暗色下
 *      浅色系被冲淡、hover 背景发白——真实缺陷修复）；同时补写 --el-color-primary-rgb（EP 有规则以
 *      rgba(var(--el-color-primary-rgb), α) 取色，只改十六进制会让这些位置对不上）；
 *   ④ 主色预设补暗色值（原型 §2.1 暗色列：主色 #5B8CFF / 成功 #36AD6A / 警告 #F2C037 / 危险 #E0574D）——
 *      同一预设在两套主题下取各自原型值，而非把浅色值硬搬到暗色。
 * @module admin-web/store
 */

import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

/** 主题模式：显式浅色 / 显式暗色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'auto';

/** 合法主题模式（新增模式 = 加此处 + locales 文案 + index.html 首帧脚本同源改） */
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'auto'];

/** 缺省主题模式（新用户）：跟随系统 */
export const DEFAULT_THEME_MODE: ThemeMode = 'auto';

/** 外观持久化键（index.html 首帧上色脚本读同一键，改键须两处同步） */
export const APPEARANCE_STORAGE_KEY = 'fw_admin_appearance';

/** 系统暗色媒体查询（index.html 首帧脚本用同一串） */
export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** 主色预设：浅色值（原型 §2.1 浅色列）+ 暗色值（原型 §2.1 暗色列）；色值一律小写归一化形态 */
export const PRIMARY_PRESETS = [
  { name: '默认蓝', value: '#2f6bff', darkValue: '#5b8cff' },
  { name: '成功绿', value: '#18a058', darkValue: '#36ad6a' },
  { name: '警告橙', value: '#f0a020', darkValue: '#f2c037' },
  { name: '危险红', value: '#d93026', darkValue: '#e0574d' },
] as const;

interface AppearanceState {
  sidebarCollapsed: boolean;
  /** 用户选择的主题模式（落盘） */
  themeMode: ThemeMode;
  /** 生效主题（派生：themeMode + 系统偏好；不落盘） */
  darkMode: boolean;
  compactMode: boolean;
  primaryColor: string;
}

/** 缺省主色（小写归一化形态：写入 CSS 变量 / 持久化的值一律小写，比较时两侧同转小写） */
const DEFAULT_PRIMARY = '#2f6bff';

function defaults(): AppearanceState {
  return {
    sidebarCollapsed: false,
    themeMode: DEFAULT_THEME_MODE,
    darkMode: false,
    compactMode: false,
    primaryColor: DEFAULT_PRIMARY,
  };
}

/** 任意输入归一化为合法主题模式；非法值回落 auto */
export function resolveThemeMode(input: unknown): ThemeMode {
  return typeof input === 'string' && (THEME_MODES as readonly string[]).includes(input) ? (input as ThemeMode) : DEFAULT_THEME_MODE;
}

/** 旧版持久化（只有 darkMode 布尔）迁移：显式 light / dark，保持升级前后视觉一致 */
function legacyThemeMode(darkMode: unknown): ThemeMode {
  return typeof darkMode === 'boolean' ? (darkMode ? 'dark' : 'light') : DEFAULT_THEME_MODE;
}

/** 系统是否偏好暗色（非浏览器环境 / 不支持媒体查询时按浅色） */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(DARK_MEDIA_QUERY).matches === true;
  } catch {
    return false;
  }
}

/** 主题模式 → 生效是否暗色 */
export function resolveDarkMode(mode: ThemeMode): boolean {
  return mode === 'auto' ? systemPrefersDark() : mode === 'dark';
}

/** 读取持久化的用户偏好（存储损坏 / 隐私模式一律回落默认值） */
function readPersisted(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** #rgb / #rrggbb → 归一化小写 #rrggbb；非法输入返回 null */
function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const [r, g, b] = value.slice(1).split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

/** 读取持久化外观配置（含旧版 darkMode → themeMode 迁移） */
function loadState(): AppearanceState {
  const persisted = readPersisted();
  const stored = normalizeHex(persisted.primaryColor);
  const themeMode = 'themeMode' in persisted ? resolveThemeMode(persisted.themeMode) : legacyThemeMode(persisted.darkMode);
  return {
    sidebarCollapsed: persisted.sidebarCollapsed === true,
    themeMode,
    darkMode: resolveDarkMode(themeMode),
    compactMode: persisted.compactMode === true,
    primaryColor: stored ?? DEFAULT_PRIMARY,
  };
}

/** 解析十六进制色为 RGB 三元组 */
function parseHex(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

/** RGB → `r, g, b`（EP 的 --el-color-*-rgb 形态） */
function toRgbTriplet(hex: string): string {
  const [r, g, b] = parseHex(hex);
  return `${r}, ${g}, ${b}`;
}

/** 颜色按比例混色（weight = 目标色占比），导出供单测直接断言 */
export function mixColor(color: string, target: string, weight: number): string {
  const [r1, g1, b1] = parseHex(color);
  const [r2, g2, b2] = parseHex(target);
  const channel = (a: number, b: number): string => Math.round(a + (b - a) * weight).toString(16).padStart(2, '0');
  return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}`;
}

/**
 * 主色在当前主题下的取值：预设色取该预设的主题专属值（原型 §2.1 两列各一份），
 * 非预设色两套主题共用同一值。导出供单测断言。
 */
export function resolvePrimaryColor(color: string, dark: boolean): string {
  const preset = PRIMARY_PRESETS.find((item) => item.value.toLowerCase() === color.toLowerCase());
  if (!preset) return color;
  return dark ? preset.darkValue : preset.value;
}

/**
 * 把主色写入 Element Plus CSS 变量（--el-color-primary、rgb 三元组与派生档）。
 * 派生基准（与 CSS 令牌层 variables.css 同口径）：浅色向白混色，暗色向黑混色；dark-2 反向。
 */
function applyPrimaryColor(color: string, dark: boolean): void {
  const root = document.documentElement;
  const base = resolvePrimaryColor(color, dark);
  const lightTarget = dark ? '#000000' : '#ffffff';
  const darkTarget = dark ? '#ffffff' : '#000000';
  root.style.setProperty('--el-color-primary', base);
  root.style.setProperty('--el-color-primary-rgb', toRgbTriplet(base));
  root.style.setProperty('--el-color-primary-light-3', mixColor(base, lightTarget, 0.3));
  root.style.setProperty('--el-color-primary-light-5', mixColor(base, lightTarget, 0.5));
  root.style.setProperty('--el-color-primary-light-7', mixColor(base, lightTarget, 0.7));
  root.style.setProperty('--el-color-primary-light-8', mixColor(base, lightTarget, 0.8));
  root.style.setProperty('--el-color-primary-light-9', mixColor(base, lightTarget, 0.9));
  root.style.setProperty('--el-color-primary-dark-2', mixColor(base, darkTarget, 0.2));
}

/** 订阅系统主题变更（不支持媒体查询的环境静默跳过——仅显式模式生效） */
function bindSystemTheme(onChange: (dark: boolean) => void): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  try {
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const handler = (event: MediaQueryListEvent): void => onChange(event.matches === true);
    if (typeof media.addEventListener === 'function') media.addEventListener('change', handler);
    else if (typeof media.addListener === 'function') media.addListener(handler);
  } catch {
    // 环境不支持：仅显式 light / dark 生效
  }
}

export const useAppStore = defineStore('app', () => {
  const state = ref<AppearanceState>(loadState());

  /** 应用外观到 DOM（暗色 class / 紧凑 class / 主色变量）+ 持久化用户偏好（生效值不落盘） */
  function apply(): void {
    const root = document.documentElement;
    root.classList.toggle('dark', state.value.darkMode);
    root.classList.toggle('compact', state.value.compactMode);
    applyPrimaryColor(state.value.primaryColor, state.value.darkMode);
    try {
      localStorage.setItem(
        APPEARANCE_STORAGE_KEY,
        JSON.stringify({
          sidebarCollapsed: state.value.sidebarCollapsed,
          themeMode: state.value.themeMode,
          compactMode: state.value.compactMode,
          primaryColor: state.value.primaryColor,
        }),
      );
    } catch {
      // 隐私模式下持久化失败不影响当前会话
    }
  }

  // 任意外观变化即时落 DOM + 本地存储（immediate 保证 store 首次使用时上色，不依赖组件挂载）
  watch(state, apply, { deep: true, immediate: true });

  // 系统主题变更：仅 auto 模式跟随（显式 light / dark 是用户意图，不被系统覆盖）
  bindSystemTheme((dark) => {
    if (state.value.themeMode !== 'auto' || state.value.darkMode === dark) return;
    state.value.darkMode = dark;
  });

  function toggleSidebar(): void {
    state.value.sidebarCollapsed = !state.value.sidebarCollapsed;
  }

  function setSidebarCollapsed(collapsed: boolean): void {
    state.value.sidebarCollapsed = collapsed;
  }

  /** 切换主题模式（含即时重算生效值；DOM 由 watch 统一应用） */
  function setThemeMode(mode: ThemeMode): void {
    state.value.themeMode = resolveThemeMode(mode);
    state.value.darkMode = resolveDarkMode(state.value.themeMode);
  }

  /** 一键切换明暗：由当前生效主题反向推断目标模式（另一侧固定为显式模式） */
  function toggleDarkMode(): void {
    setThemeMode(state.value.darkMode ? 'light' : 'dark');
  }

  function toggleCompactMode(): void {
    state.value.compactMode = !state.value.compactMode;
  }

  /** 设置主色（非法色值忽略，保持当前值） */
  function setPrimaryColor(color: string): void {
    const next = normalizeHex(color);
    if (next) state.value.primaryColor = next;
  }

  return {
    state,
    setThemeMode,
    toggleSidebar,
    setSidebarCollapsed,
    toggleDarkMode,
    toggleCompactMode,
    setPrimaryColor,
  };
});

/*
 * @file 应用外观状态store（Pinia）
 * @description 布局与主题（PRD-005 FR-02）：侧边栏折叠、暗色模式、紧凑模式、主色；
 *   全部持久化到 localStorage，刷新后恢复。主题通过 CSS 变量覆盖 Element Plus 令牌，
 *   业务组件不写死颜色（docs/25-ui-prototype.md §2）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/store
 */

import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

/** 主色预设（原型 §2.1 --color-primary 浅色值） */
export const PRIMARY_PRESETS = [
  { name: '默认蓝', value: '#2F6BFF' },
  { name: '成功绿', value: '#18A058' },
  { name: '警告橙', value: '#F0A020' },
  { name: '危险红', value: '#D93026' },
] as const;

const STORAGE_KEY = 'fw_admin_appearance';

interface AppearanceState {
  sidebarCollapsed: boolean;
  darkMode: boolean;
  compactMode: boolean;
  primaryColor: string;
}

const DEFAULTS: AppearanceState = {
  sidebarCollapsed: false,
  darkMode: false,
  compactMode: false,
  primaryColor: '#2F6BFF',
};

/** 读取本地持久化的外观配置 */
function loadState(): AppearanceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppearanceState>) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 颜色按比例混色（生成 Element Plus 的 light-3/5/7/8/9 系列） */
function mix(color: string, target: string, weight: number): string {
  const parse = (hex: string): [number, number, number] => {
    const value = hex.replace('#', '');
    return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = parse(color);
  const [r2, g2, b2] = parse(target);
  const channel = (a: number, b: number): string => Math.round(a + (b - a) * weight).toString(16).padStart(2, '0');
  return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}`;
}

/** 把主色写入 Element Plus CSS 变量（--el-color-primary 及浅色系） */
function applyPrimaryColor(color: string): void {
  const root = document.documentElement;
  root.style.setProperty('--el-color-primary', color);
  root.style.setProperty('--el-color-primary-light-3', mix(color, '#ffffff', 0.3));
  root.style.setProperty('--el-color-primary-light-5', mix(color, '#ffffff', 0.5));
  root.style.setProperty('--el-color-primary-light-7', mix(color, '#ffffff', 0.7));
  root.style.setProperty('--el-color-primary-light-8', mix(color, '#ffffff', 0.8));
  root.style.setProperty('--el-color-primary-light-9', mix(color, '#ffffff', 0.9));
  root.style.setProperty('--el-color-primary-dark-2', mix(color, '#000000', 0.2));
}

export const useAppStore = defineStore('app', () => {
  const state = ref<AppearanceState>(loadState());

  /** 应用外观到 DOM（暗色 class / 紧凑 class / 主色变量） */
  function apply(): void {
    const root = document.documentElement;
    root.classList.toggle('dark', state.value.darkMode);
    root.classList.toggle('compact', state.value.compactMode);
    applyPrimaryColor(state.value.primaryColor);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value));
    } catch {
      // 隐私模式下持久化失败不影响当前会话
    }
  }

  // 任意外观变化即时落 DOM + 本地存储
  watch(state, apply, { deep: true, immediate: true });

  function toggleSidebar(): void {
    state.value.sidebarCollapsed = !state.value.sidebarCollapsed;
  }

  function setSidebarCollapsed(collapsed: boolean): void {
    state.value.sidebarCollapsed = collapsed;
  }

  function toggleDarkMode(): void {
    state.value.darkMode = !state.value.darkMode;
  }

  function toggleCompactMode(): void {
    state.value.compactMode = !state.value.compactMode;
  }

  function setPrimaryColor(color: string): void {
    state.value.primaryColor = color;
  }

  return {
    state,
    toggleSidebar,
    setSidebarCollapsed,
    toggleDarkMode,
    toggleCompactMode,
    setPrimaryColor,
  };
});

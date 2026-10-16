/*
 * @file 外观 store 单元测试（M10/E-15 暗色模式）
 * @description 覆盖主题三态（light / dark / auto）与暗色令牌的实际落地：
 *   ① auto 跟随 prefers-color-scheme，且系统切换即时生效（无需刷新）；
 *   ② 显式 light / dark 不被系统偏好覆盖（反向验证）；
 *   ③ 持久化迁移——旧版只有 darkMode 布尔时按显式模式迁移（升级前后视觉零回归），
 *      派生字段 darkMode 不落盘（落盘的是用户意图 themeMode）；
 *   ④ 主色派生按主题分流——暗色下浅色系向黑混色、dark-2 向白提亮（修复"两种模式一律向白混色"的缺陷），
 *      且预设色在暗色下取原型 §2.1 暗色值；
 *   ⑤ index.html 首帧上色脚本与 store 常量同源（键名 / 模式枚举 / 媒体查询串），防两处口径漂移。
 * @author donttemo
 * @created 2026-10-16
 * @module admin-web/store
 */

import { existsSync, readFileSync } from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  DARK_MEDIA_QUERY,
  DEFAULT_THEME_MODE,
  THEME_MODES,
  mixColor,
  useAppStore,
} from '../app';

/** 可控的 matchMedia 桩：能读当前系统偏好，也能模拟系统切换事件 */
interface FakeMediaQuery {
  matches: boolean;
  emit(dark: boolean): void;
}

let fakeMedia!: FakeMediaQuery;

/** 覆写 window.matchMedia（own property 覆盖原型方法；delete 也能生效的场景见"缺失"用例） */
function stubMatchMedia(value: unknown): void {
  Object.defineProperty(window, 'matchMedia', { value, configurable: true, writable: true });
}

function installMatchMedia(initialDark: boolean): void {
  const listeners: Array<(event: { matches: boolean }) => void> = [];
  const media = {
    matches: initialDark,
    media: DARK_MEDIA_QUERY,
    onchange: null,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.push(listener),
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    addListener: (listener: (event: { matches: boolean }) => void) => listeners.push(listener),
    removeListener: (listener: (event: { matches: boolean }) => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatchEvent: () => true,
  };
  stubMatchMedia(() => media);
  fakeMedia = {
    get matches(): boolean {
      return media.matches;
    },
    emit(dark: boolean): void {
      media.matches = dark;
      listeners.forEach((listener) => listener({ matches: dark }));
    },
  };
}

/** 读当前写入 DOM 的主色变量 */
function cssVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

function isDarkClassOn(): boolean {
  return document.documentElement.classList.contains('dark');
}

/** 持久化内容（解析后） */
function persisted(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
}

describe('外观 store（E-15 主题三态与暗色令牌）', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark', 'compact');
    document.documentElement.removeAttribute('style');
    installMatchMedia(false);
    setActivePinia(createPinia());
  });

  it('新用户默认 auto（跟随系统）且系统偏好暗色时立即上色', () => {
    installMatchMedia(true);
    setActivePinia(createPinia());
    const app = useAppStore();
    expect(app.state.themeMode).toBe(DEFAULT_THEME_MODE);
    expect(DEFAULT_THEME_MODE).toBe('auto');
    expect(app.state.darkMode).toBe(true);
    expect(isDarkClassOn()).toBe(true);
  });

  it('系统偏好浅色时 auto 不上暗色 class（正向对照）', () => {
    const app = useAppStore();
    expect(app.state.themeMode).toBe('auto');
    expect(app.state.darkMode).toBe(false);
    expect(isDarkClassOn()).toBe(false);
  });

  it('auto 下系统主题切换即时生效，无需重新创建 store', async () => {
    const app = useAppStore();
    expect(isDarkClassOn()).toBe(false);
    fakeMedia.emit(true);
    await nextTick();
    expect(app.state.darkMode).toBe(true);
    expect(isDarkClassOn()).toBe(true);
    fakeMedia.emit(false);
    await nextTick();
    expect(app.state.darkMode).toBe(false);
    expect(isDarkClassOn()).toBe(false);
  });

  it('显式 dark 不被系统浅色覆盖（反向验证）', async () => {
    const app = useAppStore();
    app.setThemeMode('dark');
    await nextTick();
    expect(app.state.darkMode).toBe(true);
    expect(isDarkClassOn()).toBe(true);
    fakeMedia.emit(false);
    await nextTick();
    expect(app.state.themeMode).toBe('dark');
    expect(app.state.darkMode).toBe(true);
    expect(isDarkClassOn()).toBe(true);
  });

  it('显式 light 不被系统暗色覆盖（反向验证）', async () => {
    installMatchMedia(true);
    setActivePinia(createPinia());
    const app = useAppStore();
    app.setThemeMode('light');
    await nextTick();
    expect(app.state.darkMode).toBe(false);
    expect(isDarkClassOn()).toBe(false);
    fakeMedia.emit(true);
    await nextTick();
    expect(app.state.darkMode).toBe(false);
  });

  it('切回 auto 时按当前系统偏好重算（显式模式期间的系统变化不丢）', async () => {
    const app = useAppStore();
    app.setThemeMode('light');
    fakeMedia.emit(true);
    await nextTick();
    expect(app.state.darkMode).toBe(false);
    app.setThemeMode('auto');
    await nextTick();
    expect(app.state.darkMode).toBe(true);
    expect(isDarkClassOn()).toBe(true);
  });

  it('toggleDarkMode 由生效主题反向推断且固定为显式模式（不再跟随系统）', async () => {
    installMatchMedia(true);
    setActivePinia(createPinia());
    const app = useAppStore();
    expect(app.state.themeMode).toBe('auto');
    app.toggleDarkMode();
    await nextTick();
    expect(app.state.themeMode).toBe('light');
    expect(app.state.darkMode).toBe(false);
    app.toggleDarkMode();
    await nextTick();
    expect(app.state.themeMode).toBe('dark');
    expect(app.state.darkMode).toBe(true);
  });

  it('持久化写用户意图 themeMode，派生字段 darkMode 不落盘', async () => {
    const app = useAppStore();
    app.toggleDarkMode();
    await nextTick();
    expect(persisted()).toEqual({
      sidebarCollapsed: false,
      themeMode: 'dark',
      compactMode: false,
      primaryColor: '#2f6bff',
    });
    expect('darkMode' in persisted()).toBe(false);
  });

  it('旧版持久化 { darkMode: true } 迁移为显式 dark（升级前后视觉零回归）', () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ sidebarCollapsed: true, darkMode: true, compactMode: false, primaryColor: '#2F6BFF' }));
    const app = useAppStore();
    expect(app.state.themeMode).toBe('dark');
    expect(app.state.darkMode).toBe(true);
    expect(app.state.sidebarCollapsed).toBe(true);
    expect(isDarkClassOn()).toBe(true);
    expect(app.state.primaryColor).toBe('#2f6bff');
  });

  it('旧版持久化 { darkMode: false } 迁移为显式 light（不会被新版默认 auto 改写）', () => {
    installMatchMedia(true);
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ darkMode: false }));
    const app = useAppStore();
    expect(app.state.themeMode).toBe('light');
    expect(app.state.darkMode).toBe(false);
    expect(isDarkClassOn()).toBe(false);
  });

  it('非法 themeMode / 损坏存储一律回落默认值且不抛错', () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ themeMode: 'neon', primaryColor: 'red' }));
    const first = useAppStore();
    expect(first.state.themeMode).toBe('auto');
    expect(first.state.primaryColor).toBe('#2f6bff');

    setActivePinia(createPinia());
    localStorage.setItem(APPEARANCE_STORAGE_KEY, '{not json');
    expect(() => useAppStore()).not.toThrow();
    expect(useAppStore().state.themeMode).toBe('auto');
  });

  it('非浏览器可用的 matchMedia 缺失时 auto 按浅色处理（不抛错）', () => {
    stubMatchMedia(undefined);
    expect(() => useAppStore()).not.toThrow();
    expect(useAppStore().state.darkMode).toBe(false);
  });

  it('浅色下主色派生向白混色（预设取原型浅色值）', async () => {
    const app = useAppStore();
    app.setPrimaryColor('#2F6BFF');
    await nextTick();
    expect(cssVar('--el-color-primary')).toBe('#2f6bff');
    expect(cssVar('--el-color-primary-rgb')).toBe('47, 107, 255');
    expect(cssVar('--el-color-primary-light-3')).toBe(mixColor('#2f6bff', '#ffffff', 0.3));
    expect(cssVar('--el-color-primary-light-9')).toBe(mixColor('#2f6bff', '#ffffff', 0.9));
    expect(cssVar('--el-color-primary-dark-2')).toBe(mixColor('#2f6bff', '#000000', 0.2));
  });

  it('暗色下主色派生向黑混色、dark-2 向白提亮（修复锚点），且预设取暗色值', async () => {
    installMatchMedia(true);
    setActivePinia(createPinia());
    const app = useAppStore();
    await nextTick();
    expect(app.state.darkMode).toBe(true);
    expect(cssVar('--el-color-primary')).toBe('#5b8cff');
    expect(cssVar('--el-color-primary-light-3')).toBe(mixColor('#5b8cff', '#000000', 0.3));
    expect(cssVar('--el-color-primary-dark-2')).toBe(mixColor('#5b8cff', '#ffffff', 0.2));
    // 反向对照：暗色口径与浅色口径必须不同（原缺陷=两种模式同一套混色目标）
    expect(cssVar('--el-color-primary-light-3')).not.toBe(mixColor('#5b8cff', '#ffffff', 0.3));
  });

  it('明暗切换后主色变量按新主题重算', async () => {
    const app = useAppStore();
    const lightTint = cssVar('--el-color-primary-light-3');
    app.setThemeMode('dark');
    await nextTick();
    const darkTint = cssVar('--el-color-primary-light-3');
    expect(darkTint).not.toBe(lightTint);
    expect(darkTint).toBe(mixColor('#5b8cff', '#000000', 0.3));
  });

  it('非预设主色两套主题共用同一值（无暗色变体时不猜测）', async () => {
    const app = useAppStore();
    app.setPrimaryColor('#123456');
    await nextTick();
    expect(cssVar('--el-color-primary')).toBe('#123456');
    app.setThemeMode('dark');
    await nextTick();
    expect(cssVar('--el-color-primary')).toBe('#123456');
    expect(cssVar('--el-color-primary-rgb')).toBe('18, 52, 86');
  });

  it('非法主色忽略（保持当前值），三色简写归一化为六位', async () => {
    const app = useAppStore();
    app.setPrimaryColor('red');
    await nextTick();
    expect(app.state.primaryColor).toBe('#2f6bff');
    app.setPrimaryColor('#f0a');
    await nextTick();
    expect(app.state.primaryColor).toBe('#ff00aa');
  });

  it('紧凑模式与暗色互不影响，且各自持久化', async () => {
    const app = useAppStore();
    app.toggleCompactMode();
    await nextTick();
    expect(document.documentElement.classList.contains('compact')).toBe(true);
    expect(isDarkClassOn()).toBe(false);
    expect(persisted().compactMode).toBe(true);
    app.toggleDarkMode();
    await nextTick();
    expect(isDarkClassOn()).toBe(true);
    expect(persisted().themeMode).toBe('dark');
    expect(persisted().compactMode).toBe(true);
  });

  it('index.html 首帧上色脚本与 store 常量同源（键名 / 模式枚举 / 媒体查询串）', () => {
    // import.meta.url 在本仓宿主环境不是 file: URL，按 cwd 解析（包内跑 = 包根，仓库根跑 = 仓库根）
    const candidates = [`${process.cwd()}/index.html`, `${process.cwd()}/apps/admin-web/index.html`];
    const htmlPath = candidates.find((path) => existsSync(path));
    expect(htmlPath, `未找到 index.html（cwd=${process.cwd()}）`).toBeTruthy();
    const html = readFileSync(htmlPath as string, 'utf8');
    expect(html).toContain(APPEARANCE_STORAGE_KEY);
    expect(html).toContain(DARK_MEDIA_QUERY);
    THEME_MODES.forEach((mode) => expect(html).toContain(`'${mode}'`));
    // 首帧脚本必须早于应用脚本（否则暗色用户仍会看到浅色闪屏）
    expect(html.indexOf('fw_admin_appearance')).toBeLessThan(html.indexOf('/src/main.ts'));
  });
});

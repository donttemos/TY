<!--
 * @file 顶栏
 * @description 折叠开关 + 面包屑 + 右侧动作区：暗色 / 紧凑 / 主色切换、语言切换（E-14 i18n 骨架）、
 *   全屏、用户菜单（个人中心 / 登出）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo E-14：新增语言切换下拉（简体中文 / English，选择持久化并即时切换，
 *   Element Plus 内置文案经 App.vue 的 ElConfigProvider 同步生效）
 * @modified 2026-10-15 donttemo M10 E-13：右侧动作区挂载消息中心铃铛（NotificationBell）
 * @modified 2026-10-16 donttemo M10 E-15：主题切换由「明暗二态按钮」升级为三态下拉
 *   （浅色 / 暗色 / 跟随系统）——"跟随系统" 由 store 监听 prefers-color-scheme 即时生效；
 *   图标反映当前生效主题（auto 时用 Monitor 表达"由系统决定"），文案走 E-14 locale 表
 * @module admin-web/layout
-->

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { ArrowDown, Brush, Fold, Monitor, Moon, Operation, Sunny } from '@element-plus/icons-vue';
import Breadcrumb from './Breadcrumb.vue';
import NotificationBell from './NotificationBell.vue';
import { useAppStore, PRIMARY_PRESETS, type ThemeMode } from '@/store/app';
import { useUserStore } from '@/store/user';
import { useLocale } from '@/composables/useLocale';

const app = useAppStore();
const user = useUserStore();
const router = useRouter();
const { locale, shortLabel, options, t, setLocale } = useLocale();

const displayName = computed(() => user.profile?.nickname || user.profile?.username || '未登录');

/** 主题切换器：图标反映生效主题，tooltip 显示当前模式（E-15） */
const themeIcons = { light: Sunny, dark: Moon, auto: Monitor } as const;
const themeLabels = computed<Record<ThemeMode, string>>(() => ({
  light: t('common.themeLight'),
  dark: t('common.themeDark'),
  auto: t('common.themeAuto'),
}));
const themeIcon = computed(() => (app.state.themeMode === 'auto' ? themeIcons.auto : app.state.darkMode ? themeIcons.dark : themeIcons.light));
const themeTooltip = computed(() => `${t('common.theme')}：${themeLabels.value[app.state.themeMode]}`);

/** 切换主题模式（'auto' 交由 store 读系统偏好） */
function handleThemeCommand(mode: string): void {
  app.setThemeMode(mode as ThemeMode);
}

/** 全屏切换 */
function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    void document.documentElement.requestFullscreen().catch(() => undefined);
  }
}

/** 登出：二次确认 → 服务端吊销 → 回登录页 */
async function handleLogout(): Promise<void> {
  try {
    await ElMessageBox.confirm('确认退出登录？', '提示', { type: 'warning', confirmButtonText: '退出', cancelButtonText: '取消' });
  } catch {
    return;
  }
  await user.logout();
  await router.push('/login');
}
</script>

<template>
  <header class="fw-navbar">
    <div class="fw-navbar-left">
      <el-button link class="fw-navbar-fold" @click="app.toggleSidebar()">
        <el-icon :size="18"><Fold /></el-icon>
      </el-button>
      <Breadcrumb />
    </div>
    <div class="fw-navbar-right">
      <!-- M10 E-13：消息中心铃铛（未读实时；无 notification:read 时组件自身隐藏） -->
      <NotificationBell />
      <el-tooltip :content="themeTooltip" placement="bottom">
        <el-dropdown trigger="click" @command="handleThemeCommand">
          <el-button link>
            <el-icon :size="18"><component :is="themeIcon" /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="light" :disabled="app.state.themeMode === 'light'">{{ t('common.themeLight') }}</el-dropdown-item>
              <el-dropdown-item command="dark" :disabled="app.state.themeMode === 'dark'">{{ t('common.themeDark') }}</el-dropdown-item>
              <el-dropdown-item command="auto" divided :disabled="app.state.themeMode === 'auto'">{{ t('common.themeAuto') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </el-tooltip>
      <el-tooltip :content="app.state.compactMode ? '退出紧凑模式' : '紧凑模式'" placement="bottom">
        <el-button link @click="app.toggleCompactMode()">
          <el-icon :size="18"><Operation /></el-icon>
        </el-button>
      </el-tooltip>
      <el-dropdown trigger="click" @command="(command: string) => setLocale(command)">
        <span class="fw-navbar-locale" :title="t('common.switchLanguage')">
          <span class="fw-navbar-locale-label">{{ shortLabel }}</span>
          <el-icon :size="12"><ArrowDown /></el-icon>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="item in options" :key="item.value" :command="item.value" :disabled="item.value === locale">
              {{ item.label }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-dropdown trigger="click" @command="(command: string) => command === 'profile' ? router.push('/profile') : undefined">
        <span class="fw-navbar-user">
          <el-avatar :size="28" icon="UserFilled" />
          <span class="fw-navbar-username">{{ displayName }}</span>
          <el-icon><ArrowDown /></el-icon>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="profile">个人中心</el-dropdown-item>
            <el-dropdown-item divided command="logout" @click="handleLogout">退出登录</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-popover placement="bottom-end" :width="200" trigger="click">
        <template #reference>
          <el-button link>
            <el-icon :size="18"><Brush /></el-icon>
          </el-button>
        </template>
        <div class="fw-theme-colors">
          <span v-for="preset in PRIMARY_PRESETS" :key="preset.value" class="fw-theme-color" :style="{ background: preset.value }" :title="preset.name" @click="app.setPrimaryColor(preset.value)" />
        </div>
      </el-popover>
    </div>
  </header>
</template>

<style scoped>
.fw-navbar {
  height: var(--fw-navbar-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: var(--fw-surface);
  border-bottom: 1px solid var(--fw-border);
}

.fw-navbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.fw-navbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fw-navbar-user {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--fw-text-1);
}

.fw-navbar-locale {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  color: var(--fw-text-1);
  padding: 0 4px;
}

.fw-navbar-locale-label {
  font-size: 13px;
  line-height: var(--fw-navbar-height);
}

.fw-theme-colors {
  display: flex;
  gap: 8px;
}

.fw-theme-color {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  cursor: pointer;
  border: 1px solid var(--fw-border);
}
</style>

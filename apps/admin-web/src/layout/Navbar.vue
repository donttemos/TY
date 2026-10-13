<!--
 * @file 顶栏
 * @description 折叠开关 + 面包屑 + 右侧动作区：暗色 / 紧凑 / 主色切换、全屏、用户菜单（个人中心 / 登出）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/layout
-->

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { ArrowDown, Brush, Fold, Moon, Operation, Sunny } from '@element-plus/icons-vue';
import Breadcrumb from './Breadcrumb.vue';
import { useAppStore, PRIMARY_PRESETS } from '@/store/app';
import { useUserStore } from '@/store/user';

const app = useAppStore();
const user = useUserStore();
const router = useRouter();

const displayName = computed(() => user.profile?.nickname || user.profile?.username || '未登录');

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
      <el-tooltip :content="app.state.darkMode ? '切换浅色' : '切换暗色'" placement="bottom">
        <el-button link @click="app.toggleDarkMode()">
          <el-icon :size="18"><component :is="app.state.darkMode ? Sunny : Moon" /></el-icon>
        </el-button>
      </el-tooltip>
      <el-tooltip :content="app.state.compactMode ? '退出紧凑模式' : '紧凑模式'" placement="bottom">
        <el-button link @click="app.toggleCompactMode()">
          <el-icon :size="18"><Operation /></el-icon>
        </el-button>
      </el-tooltip>
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

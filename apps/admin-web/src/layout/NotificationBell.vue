<!--
 * @file 消息中心铃铛（M10 E-13）
 * @description 顶栏常驻元素：未读角标 + 下拉消息列表（最近 8 条）+ 全部已读 + 单条已读/删除。
 *   实时性来自 `store/notification`（消费共享 SSE 的 `notification` 事件），因此「任务在别的页面跑完」
 *   这里会立刻冒红点，而不依赖轮询。
 *   无 `notification:read` 的账号整块隐藏（`store.available === false`）——不显示一个点了报错的图标。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/layout
-->

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Bell } from '@element-plus/icons-vue';
import { BELL_PREVIEW_SIZE, useNotificationStore } from '@/store/notification';
import { useUserStore } from '@/store/user';
import { formatRelativeTime } from '@/utils/relative-time';
import { BizError, describeBizError } from '@/utils/biz-error';
import type { NotificationLevel, NotificationView } from '@/api/types';

const notifications = useNotificationStore();
const user = useUserStore();

/** 下拉是否展开（展开时刷新列表，保证「打开即最新」） */
const opened = ref(false);

/** 挂载即接管（与任务条同款：按当前用户恢复） */
onMounted(() => {
  const id = user.profile?.id;
  if (id) notifications.restore(id);
});

/** 换号 / 登出：换人重建，登出清空 */
watch(
  () => ({ id: user.profile?.id, loggedIn: user.isLoggedIn }),
  (next) => {
    if (next.loggedIn && next.id) notifications.restore(next.id);
    else if (!next.loggedIn) notifications.reset();
  },
);

/** 展开时拉取最新（实时断了也不会看到过期列表） */
watch(opened, (next) => {
  if (next) void notifications.load({ page: 1, pageSize: BELL_PREVIEW_SIZE });
});

/** 级别 → 展示色点样式 */
function dotClass(level: NotificationLevel): string {
  return `fw-bell-dot is-${level}`;
}

/** 点击消息：标记已读（不改页面跳转——消息多为「结果已在任务条/队列页」的通知） */
async function onSelect(item: NotificationView): Promise<void> {
  if (item.read) return;
  try {
    await notifications.markRead(item.id);
  } catch (error) {
    ElMessage.error(error instanceof BizError ? describeBizError(error) : '标记已读失败');
  }
}

/** 全部已读 */
async function onReadAll(): Promise<void> {
  try {
    const updated = await notifications.markAllRead();
    ElMessage.success(updated > 0 ? `已标记 ${updated} 条为已读` : '没有未读消息');
  } catch (error) {
    ElMessage.error(error instanceof BizError ? describeBizError(error) : '操作失败，请稍后重试');
  }
}

/** 删除单条 */
async function onRemove(item: NotificationView): Promise<void> {
  try {
    await notifications.remove(item.id);
  } catch (error) {
    ElMessage.error(error instanceof BizError ? describeBizError(error) : '删除失败，请稍后重试');
  }
}

onBeforeUnmount(() => {
  // 只注销消费者，不关共享连接（任务条可能还在用）
  notifications.reset();
});
</script>

<template>
  <el-popover v-if="notifications.available" v-model:visible="opened" placement="bottom-end" :width="360" trigger="click">
    <template #reference>
      <el-badge :value="notifications.unread" :max="99" :hidden="!notifications.hasUnread" class="fw-bell-badge">
        <el-button link class="fw-bell-trigger" aria-label="消息中心">
          <el-icon :size="18"><Bell /></el-icon>
        </el-button>
      </el-badge>
    </template>

    <div class="fw-bell">
      <div class="fw-bell-head">
        <span class="fw-bell-title">消息中心</span>
        <span v-if="notifications.hasUnread" class="fw-bell-count">未读 {{ notifications.unread }}</span>
        <el-button link size="small" :disabled="!notifications.hasUnread" @click="onReadAll">全部已读</el-button>
      </div>

      <div v-if="notifications.loading && notifications.items.length === 0" class="fw-bell-empty">加载中…</div>
      <div v-else-if="notifications.items.length === 0" class="fw-bell-empty">暂无消息</div>
      <ul v-else class="fw-bell-list">
        <li
          v-for="item in notifications.items"
          :key="item.id"
          class="fw-bell-item"
          :class="{ 'is-unread': !item.read }"
          @click="onSelect(item)"
        >
          <span :class="dotClass(item.level)" />
          <div class="fw-bell-item-body">
            <div class="fw-bell-item-title" :title="item.title">{{ item.title }}</div>
            <div v-if="item.content" class="fw-bell-item-content" :title="item.content">{{ item.content }}</div>
            <div class="fw-bell-item-meta">
              <span>{{ formatRelativeTime(item.createdAt) }}</span>
              <span v-if="item.traceId" class="fw-bell-trace" :title="item.traceId">traceId</span>
            </div>
          </div>
          <el-button link size="small" class="fw-bell-remove" @click.stop="onRemove(item)">删除</el-button>
        </li>
      </ul>

      <div v-if="notifications.total > notifications.items.length" class="fw-bell-more">
        共 {{ notifications.total }} 条，仅展示最近 {{ notifications.items.length }} 条
      </div>
    </div>
  </el-popover>
</template>

<style scoped>
.fw-bell-badge {
  display: inline-flex;
  align-items: center;
}

.fw-bell-trigger {
  padding: 0 4px;
}

.fw-bell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fw-bell-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--fw-border);
}

.fw-bell-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fw-text-1);
}

.fw-bell-count {
  font-size: 12px;
  color: var(--el-color-danger);
}

.fw-bell-head .el-button {
  margin-left: auto;
}

.fw-bell-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--fw-text-3);
}

.fw-bell-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 320px;
  overflow-y: auto;
}

.fw-bell-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 4px;
  cursor: pointer;
}

.fw-bell-item + .fw-bell-item {
  border-top: 1px solid var(--fw-border);
}

.fw-bell-item:hover {
  background: var(--el-fill-color-light);
}

.fw-bell-item.is-unread .fw-bell-item-title {
  font-weight: 600;
}

.fw-bell-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--el-color-info);
}

.fw-bell-dot.is-success {
  background: var(--el-color-success);
}

.fw-bell-dot.is-warning {
  background: var(--el-color-warning);
}

.fw-bell-dot.is-error {
  background: var(--el-color-danger);
}

.fw-bell-item-body {
  flex: 1;
  min-width: 0;
}

.fw-bell-item-title {
  font-size: 13px;
  color: var(--fw-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fw-bell-item-content {
  margin-top: 2px;
  font-size: 12px;
  color: var(--fw-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fw-bell-item-meta {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--fw-text-3);
}

.fw-bell-trace {
  font-family: monospace;
}

.fw-bell-remove {
  flex-shrink: 0;
}

.fw-bell-more {
  padding-top: 6px;
  border-top: 1px solid var(--fw-border);
  font-size: 11px;
  color: var(--fw-text-3);
  text-align: center;
}
</style>

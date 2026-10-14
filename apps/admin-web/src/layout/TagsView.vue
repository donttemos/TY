<!--
 * @file 多标签页（TagsView）
 * @description 打开过的路由保留标签，支持刷新当前页、关闭其它、关闭全部（原型 §4）；
 *   标签列表按路由维度本地持久化，刷新浏览器后恢复。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 存储键按用户隔离（`fw_admin_tags:<用户 id>`）：原先所有账号共用一个键，
 *   登出换号后仍会列出上一个账号开过的标签（点进去落 403），且会把新账号的标签写进同一个键互相污染。
 *   改为「存储键随当前用户变化」——切换账号即自动读取该账号自己的标签（首个账号视为空），无需登出侧改代码。
 *   注：旧键 `fw_admin_tags` 不做迁移（无法判断标签属于哪个账号，迁移会把上一个账号的标签泄露给新账号）。
 * @module admin-web/layout
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUserStore } from '@/store/user';

interface Tag {
  path: string;
  title: string;
  affix: boolean;
}

const STORAGE_PREFIX = 'fw_admin_tags';

const route = useRoute();
const router = useRouter();
const user = useUserStore();
const tags = ref<Tag[]>([]);

/** 存储键：按登录用户隔离，换号即自动切到对方的标签集合 */
const storageKey = computed(() => `${STORAGE_PREFIX}:${user.profile?.id ?? 'anonymous'}`);

/** 从本地存储恢复该账号的标签 */
function restore(): void {
  try {
    const raw = localStorage.getItem(storageKey.value);
    tags.value = raw ? (JSON.parse(raw) as Tag[]) : [];
  } catch {
    tags.value = [];
  }
}

/** 当前路由入签（忽略隐藏页：登录 / 403 / 404 / 个人中心） */
function addCurrentTag(): void {
  const meta = route.meta;
  if (meta?.hiddenInTabs) return;
  const exists = tags.value.some((t) => t.path === route.path);
  if (!exists) {
    tags.value.push({ path: route.path, title: String(meta?.title ?? route.path), affix: Boolean(meta?.affix) });
  }
}

// 用户变化（登出换号）→ 换成该账号自己的标签，并把当前页入签
watch(storageKey, () => {
  restore();
  addCurrentTag();
});
watch(() => route.fullPath, addCurrentTag);
watch(tags, (value) => {
  try {
    localStorage.setItem(storageKey.value, JSON.stringify(value));
  } catch {
    // 隐私模式下降级为仅内存
  }
}, { deep: true });

// 首屏装配：恢复该账号的标签 + 当前页入签。
// 必须放在 watcher 注册**之后**，否则初始状态不会被写回本地（刷新后丢标签）。
restore();
addCurrentTag();

const activeTag = computed(() => route.path);

function go(tag: Tag): void {
  void router.push(tag.path);
}

function close(tag: Tag): void {
  const index = tags.value.findIndex((t) => t.path === tag.path);
  tags.value = tags.value.filter((t) => t.path !== tag.path);
  if (tag.path === route.path) {
    const next = tags.value[Math.min(index, tags.value.length - 1)];
    if (next) void router.push(next.path);
    else void router.push('/dashboard');
  }
}

function closeOthers(): void {
  tags.value = tags.value.filter((t) => t.affix || t.path === route.path);
}

function closeAll(): void {
  tags.value = tags.value.filter((t) => t.affix);
  if (!tags.value.some((t) => t.path === route.path)) void router.push('/dashboard');
}

/** 刷新当前页：先重定向到重定向页再回来（触发组件重建） */
function refresh(): void {
  void router.replace({ path: '/redirect' + route.fullPath });
}
</script>

<template>
  <div class="fw-tags">
    <div class="fw-tags-scroll">
      <span
        v-for="tag in tags"
        :key="tag.path"
        class="fw-tag"
        :class="{ active: tag.path === activeTag }"
        @click="go(tag)"
      >
        {{ tag.title }}
        <span v-if="!tag.affix" class="fw-tag-close" @click.stop="close(tag)">×</span>
      </span>
    </div>
    <div class="fw-tags-actions">
      <el-button link type="primary" size="small" @click="refresh">刷新</el-button>
      <el-button link type="primary" size="small" @click="closeOthers">关闭其它</el-button>
      <el-button link type="primary" size="small" @click="closeAll">关闭全部</el-button>
    </div>
  </div>
</template>

<style scoped>
.fw-tags {
  height: var(--fw-tags-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--fw-surface);
  border-bottom: 1px solid var(--fw-border);
}

.fw-tags-scroll {
  display: flex;
  gap: 6px;
  overflow-x: auto;
}

.fw-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid var(--fw-border);
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  color: var(--fw-text-2);
}

.fw-tag.active {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.fw-tag-close {
  border-radius: 50%;
  padding: 0 2px;
}

.fw-tag-close:hover {
  background: var(--el-color-danger-light-8);
  color: var(--el-color-danger);
}
</style>

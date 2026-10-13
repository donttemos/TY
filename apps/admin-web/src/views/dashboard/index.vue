<!--
 * @file 工作台
 * @description 登录落地页：欢迎区 + 统计卡（用户 / 角色 / 权限点 / 审计记录数，取自分页接口 total）
 *   + 常用入口。数据并发拉取，单项失败不阻塞整体。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/views
-->

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/store/user';
import * as userApi from '@/api/user';
import * as roleApi from '@/api/role';
import * as auditApi from '@/api/audit';

const router = useRouter();
const user = useUserStore();

const stats = ref({ users: 0, roles: 0, permissions: 0, audits: 0 });
const greeting = ref('');

onMounted(async () => {
  const hour = new Date().getHours();
  greeting.value = hour < 6 ? '凌晨好' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';

  const [users, roles, permissions, audits] = await Promise.all([
    userApi.fetchUsers({ pageSize: 1 }).catch(() => null),
    roleApi.fetchRoles().catch(() => null),
    roleApi.fetchPermissionGroups().catch(() => null),
    auditApi.fetchAuditLogs({ pageSize: 1 }).catch(() => null),
  ]);
  stats.value = {
    users: users?.total ?? 0,
    roles: roles?.length ?? 0,
    permissions: permissions?.reduce((sum, group) => sum + group.items.length, 0) ?? 0,
    audits: audits?.total ?? 0,
  };
});

const quickLinks = [
  { title: '用户管理', path: '/system/users', desc: '账号、角色分配与状态' },
  { title: '角色权限', path: '/system/roles', desc: '菜单 / 按钮 / 接口三层授权' },
  { title: '审计日志', path: '/system/audit-logs', desc: '操作记录与字段级 diff' },
];
</script>

<template>
  <div class="fw-page">
    <div class="fw-card">
      <h2 class="fw-dashboard-greeting">{{ greeting }}，{{ user.profile?.nickname || user.profile?.username }}</h2>
      <p class="fw-text-secondary">当前角色：{{ user.profile?.roles.join('、') || '—' }} ｜ 数据范围：{{ user.profile?.dataScope || '—' }}</p>
    </div>

    <div class="fw-dashboard-stats">
      <div v-for="stat in [
        { label: '用户数', value: stats.users },
        { label: '角色数', value: stats.roles },
        { label: '权限点', value: stats.permissions },
        { label: '审计记录', value: stats.audits },
      ]" :key="stat.label" class="fw-card fw-dashboard-stat">
        <div class="fw-dashboard-stat-value">{{ stat.value }}</div>
        <div class="fw-text-weak">{{ stat.label }}</div>
      </div>
    </div>

    <div class="fw-card">
      <h3 class="fw-dashboard-section-title">常用入口</h3>
      <div class="fw-dashboard-links">
        <div v-for="link in quickLinks" :key="link.path" class="fw-dashboard-link" @click="router.push(link.path)">
          <div class="fw-dashboard-link-title">{{ link.title }}</div>
          <div class="fw-text-weak">{{ link.desc }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fw-dashboard-greeting {
  margin: 0 0 8px;
  font-size: 20px;
}

.fw-dashboard-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  margin: 16px 0;
}

.fw-dashboard-stat {
  text-align: center;
}

.fw-dashboard-stat-value {
  font-size: 28px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.fw-dashboard-section-title {
  margin: 0 0 12px;
  font-size: 16px;
}

.fw-dashboard-links {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.fw-dashboard-link {
  padding: 12px;
  border: 1px solid var(--fw-border);
  border-radius: 8px;
  cursor: pointer;
}

.fw-dashboard-link:hover {
  border-color: var(--el-color-primary);
}

.fw-dashboard-link-title {
  font-weight: 600;
  margin-bottom: 4px;
}
</style>

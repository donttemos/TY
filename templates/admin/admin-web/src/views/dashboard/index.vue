<!--
 * @file 工作台
 * @description 登录落地页：欢迎区 + 统计卡（用户 / 角色 / 权限点 / 审计记录数，取自分页接口 total）
 *   + 常用入口。数据并发拉取，单项失败不阻塞整体。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 真机实测修复：原先无条件并发请求 /users、/roles、/permissions、/audit-logs，
 *   低权限账号（如 alice：仅 user:read + dict:read）登录后必然产生 3 条 403，且把**无权读取的指标显示成 0**
 *   —— 0 与「真实为 0」无法区分，属误导；「常用入口」也会列出无权进入的页面。
 *   改为：① 每个指标按其**后端守卫权限码**决定是否请求（无权限不发请求 → 不产生 403）；
 *   ② 统计卡三态化（加载中 / 有值 / 取数失败显示「—」），不再用 0 冒充；
 *   ③ 常用入口按权限过滤；④ 一个指标都不可读时给出明确说明而非空卡片。
 *   权限码与后端守卫的对应：/users=user:read、/roles=role:read、/permissions=permission:read、/audit-logs=audit:read
 * @modified 2026-10-15 donttemo R4-05 收口：统计口径与 dataScope 对齐标注。后端 /users 与 /audit-logs
 *   已按 dataScope 四档收敛（M8 T-M8-04），self/org 用户看到的 total 即「其范围内数量」，
 *   与列表页所见一致——口径本身无误，缺的是**标注**：非 all 档时在范围敏感卡（用户数 / 审计记录）
 *   副标题标注生效范围，避免「用户数 1」被误读为全站规模；角色数 / 权限点是全局目录（无范围概念），不标注。
 * @module __APP_NAME__-web/views
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/store/user';
import * as userApi from '@/api/user';
import * as roleApi from '@/api/role';
import * as auditApi from '@/api/audit';
import type { PermissionCode } from '@/api/types';

const router = useRouter();
const user = useUserStore();

/** 统计卡定义：permission 必须与后端端点的守卫权限码一致，否则要么白拿 403、要么漏显示 */
interface StatDef {
  label: string;
  permission: PermissionCode;
  /** true = 该指标受 dataScope 收敛（后端按调用方范围过滤 total），需随档位标注口径（R4-05） */
  scoped?: boolean;
  /** 返回该指标的数值；失败由调用方兜成 null（显示「—」） */
  load: () => Promise<number>;
}

const STAT_DEFS: StatDef[] = [
  { label: '用户数', permission: 'user:read', scoped: true, load: async () => (await userApi.fetchUsers({ pageSize: 1 })).total },
  { label: '角色数', permission: 'role:read', load: async () => (await roleApi.fetchRoles()).length },
  {
    label: '权限点',
    permission: 'permission:read',
    load: async () => (await roleApi.fetchPermissionGroups()).reduce((sum, group) => sum + group.items.length, 0),
  },
  { label: '审计记录', permission: 'audit:read', scoped: true, load: async () => (await auditApi.fetchAuditLogs({ pageSize: 1 })).total },
];

/** dataScope 档位 → 口径标注文案（与角色表单字典 data_scope 同语义） */
const SCOPE_NOTES: Record<string, string> = {
  org: '（限本部门）',
  org_below: '（限本部门及下级）',
  self: '（限本人）',
};

/** 非 all 档的口径标注（all = 全部数据，无需标注） */
const scopeNote = computed(() => {
  const ds = user.profile?.dataScope;
  return (ds && ds !== 'all' && SCOPE_NOTES[ds]) || '';
});

/** 常用入口：同样按权限过滤，避免出现点了就 403 的死入口
 *  （admin 模板裁剪说明：审计日志页未随模板下发，仅保留后端查询端点与统计卡；
 *  补页面时参照 apps/admin-web 的 views/system/audit-logs 即可） */
const QUICK_LINKS: { title: string; path: string; desc: string; permission: PermissionCode }[] = [
  { title: '用户管理', path: '/system/users', desc: '账号、角色分配与状态', permission: 'user:read' },
  { title: '角色权限', path: '/system/roles', desc: '菜单 / 按钮 / 接口三层授权', permission: 'role:read' },
  { title: 'DemoItem管理', path: '/demo-items', desc: 'fw gen crud 生成的示例 CRUD', permission: 'demo-item:read' },
];

const quickLinks = computed(() => QUICK_LINKS.filter((link) => user.hasPermission(link.permission)));

interface StatCard {
  label: string;
  /** null = 取数失败（显示「—」），与真实的 0 区分开 */
  value: number | null;
  /** 口径标注（仅范围敏感卡在非 all 档携带；空串 = 不标注） */
  note: string;
}

const loading = ref(true);
const cards = ref<StatCard[]>([]);
const greeting = ref('');

onMounted(async () => {
  const hour = new Date().getHours();
  greeting.value = hour < 6 ? '凌晨好' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';

  // 只请求当前账号有权限读取的指标：无权端点不发请求，既不刷 403 也不产生误导性的 0
  const visible = STAT_DEFS.filter((def) => user.hasPermission(def.permission));
  cards.value = await Promise.all(
    visible.map(async (def): Promise<StatCard> => {
      const note = def.scoped ? scopeNote.value : '';
      try {
        return { label: def.label, value: await def.load(), note };
      } catch {
        return { label: def.label, value: null, note };
      }
    }),
  );
  loading.value = false;
});
</script>

<template>
  <div class="fw-page">
    <div class="fw-card">
      <h2 class="fw-dashboard-greeting">{{ greeting }}，{{ user.profile?.nickname || user.profile?.username }}</h2>
      <p class="fw-text-secondary">当前角色：{{ user.profile?.roles.join('、') || '—' }} ｜ 数据范围：{{ user.profile?.dataScope || '—' }}</p>
    </div>

    <div v-if="loading" v-loading="true" class="fw-card fw-dashboard-loading" element-loading-text="加载中…" />
    <div v-else-if="cards.length" class="fw-dashboard-stats">
      <div v-for="card in cards" :key="card.label" class="fw-card fw-dashboard-stat">
        <div class="fw-dashboard-stat-value">{{ card.value ?? '—' }}</div>
        <div class="fw-text-weak">
          {{ card.label }}<span v-if="card.note" class="fw-dashboard-scope-note">{{ card.note }}</span>
        </div>
      </div>
    </div>
    <div v-else class="fw-card">
      <p class="fw-text-weak">当前角色没有可查看的统计指标（需要 user:read / role:read / permission:read / audit:read 之一）。</p>
    </div>

    <div v-if="quickLinks.length" class="fw-card">
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

.fw-dashboard-loading {
  height: 104px;
  margin: 16px 0;
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

.fw-dashboard-scope-note {
  color: var(--el-color-warning);
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

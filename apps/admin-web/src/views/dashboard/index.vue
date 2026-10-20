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
 * @module admin-web/views
 * @modified 2026-10-20 donttemo M14/PRD-014 B4（FR-14-14）：新增「SaaS 运营」卡区——ops:saas:read
 *   才请求 /saas/usage/overview（无权限不发请求，沿 R4-05 范式不刷 403、不用 0 冒充）：五态计数 +
 *   7 天内到期订阅 + 配额风险（≥80% TOP）+ 最近迁移；每项可点击跳转对应运营页。常用入口补套餐/
 *   订阅/生命周期三项（按权限过滤）。
 * @modified 2026-10-20 donttemo M14 跨页闭环：三处租户级跳转收敛到 goTenantPage(对象式 push + query)，
 *   与目标页 useTenantQuery 的 `?tenantId=` 契约同源（避免字符串拼接漏 encode）。
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/store/user';
import * as userApi from '@/api/user';
import * as roleApi from '@/api/role';
import * as auditApi from '@/api/audit';
import { fetchOpsOverview } from '@/api/saas';
import type { OpsOverview } from '@/api/saas';
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

/** 常用入口：同样按权限过滤，避免出现点了就 403 的死入口 */
const QUICK_LINKS: { title: string; path: string; desc: string; permission: PermissionCode }[] = [
  { title: '用户管理', path: '/system/users', desc: '账号、角色分配与状态', permission: 'user:read' },
  { title: '角色权限', path: '/system/roles', desc: '菜单 / 按钮 / 接口三层授权', permission: 'role:read' },
  { title: '审计日志', path: '/system/audit-logs', desc: '操作记录与字段级 diff', permission: 'audit:read' },
  { title: '套餐管理', path: '/saas/plans', desc: '套餐版本、配额与发布', permission: 'ops:saas:read' },
  { title: '订阅管理', path: '/saas/subscriptions', desc: '全局订阅、状态与详情', permission: 'ops:saas:read' },
  { title: '租户生命周期', path: '/saas/lifecycle', desc: '状态迁移与操作时间线', permission: 'ops:saas:read' },
];

/** SaaS 运营卡区（FR-14-14）：权限门控取数，失败降级为 null（显示「—」不用 0 冒充） */
const saasCanRead = computed(() => user.hasPermission('ops:saas:read'));
const saasLoading = ref(true);
const saasOverview = ref<OpsOverview | null>(null);
const saasFailed = ref(false);

/** 五态计数卡定义（顺序即展示顺序） */
const SAAS_STATUS_CARDS: Array<{ key: keyof OpsOverview['tenantCounts']; label: string; path: string }> = [
  { key: 'active', label: '生效中', path: '/saas/subscriptions' },
  { key: 'grace', label: '宽限期', path: '/saas/subscriptions' },
  { key: 'frozen', label: '已冻结', path: '/saas/lifecycle' },
  { key: 'terminated', label: '已终止', path: '/saas/lifecycle' },
];

/** 剩余天数（到期文案；负数 = 已过期） */
function daysLeft(expireAt: string | null): string {
  if (!expireAt) return '无期限';
  const d = Math.ceil((new Date(expireAt).getTime() - Date.now()) / 86_400_000);
  return d >= 0 ? `${d} 天` : `已逾期 ${-d} 天`;
}

/**
 * 带租户上下文跳转运营页（M14 跨页闭环）：租户以 query 承载（OQ-14-4 定案），
 * 目标页用 useTenantQuery 初始化选择器并自动取数，运营人员无需二次选择。
 */
function goTenantPage(path: string, tenantId: string): void {
  void router.push({ path, query: { tenantId } });
}

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

  // SaaS 运营总览：无 ops:saas:read 不发请求（不刷 403、不显示误导性 0）
  if (saasCanRead.value) {
    try {
      saasOverview.value = await fetchOpsOverview();
    } catch {
      saasFailed.value = true;
    }
  }
  saasLoading.value = false;
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

    <!-- SaaS 运营卡区（M14 FR-14-14）：权限门控；失败显示「—」不用 0 冒充 -->
    <div v-if="saasCanRead" class="fw-card">
      <h3 class="fw-dashboard-section-title">SaaS 运营</h3>
      <div v-loading="saasLoading" class="fw-saas-body">
        <template v-if="saasOverview">
          <div class="fw-saas-status-row">
            <div v-for="c in SAAS_STATUS_CARDS" :key="c.key" class="fw-saas-status-card" @click="router.push(c.path)">
              <div class="fw-saas-status-value">{{ saasOverview.tenantCounts[c.key] }}</div>
              <div class="fw-text-weak">{{ c.label }}</div>
            </div>
          </div>
          <div class="fw-saas-grid">
            <div>
              <h4 class="fw-saas-sub-title">即将到期订阅（7 天）</h4>
              <div v-if="saasOverview.expiringSubscriptions.length" class="fw-saas-list">
                <div v-for="s in saasOverview.expiringSubscriptions" :key="s.subscriptionId" class="fw-saas-item" @click="goTenantPage('/saas/subscriptions', s.tenantId)">
                  <span class="fw-saas-item-main">{{ s.tenantId }}</span>
                  <span class="fw-text-weak">{{ daysLeft(s.expireAt) }}</span>
                </div>
              </div>
              <p v-else class="fw-text-weak">7 天内无到期订阅。</p>
            </div>
            <div>
              <h4 class="fw-saas-sub-title">配额风险（≥80%）</h4>
              <div v-if="saasOverview.quotaRisks.length" class="fw-saas-list">
                <div v-for="(r, i) in saasOverview.quotaRisks.slice(0, 5)" :key="`${r.tenantId}-${r.quotaKey}-${r.windowType}-${i}`" class="fw-saas-item" @click="goTenantPage('/saas/usage', r.tenantId)">
                  <span class="fw-saas-item-main">{{ r.quotaKey }}</span>
                  <el-progress :percentage="Math.min(100, Math.round(r.ratio))" :stroke-width="10" :status="r.ratio >= 100 ? 'exception' : 'warning'" class="fw-saas-ratio" />
                  <span class="fw-text-weak">{{ r.used }}/{{ r.limitValue }}</span>
                </div>
              </div>
              <p v-else class="fw-text-weak">当前无接近上限的指标。</p>
            </div>
            <div>
              <h4 class="fw-saas-sub-title">最近生命周期变更</h4>
              <div v-if="saasOverview.recentTransitions.length" class="fw-saas-list">
                <div v-for="(l, i) in saasOverview.recentTransitions.slice(0, 5)" :key="i" class="fw-saas-item" @click="goTenantPage('/saas/lifecycle', l.tenantId)">
                  <span class="fw-saas-item-main">{{ l.tenantId }}</span>
                  <el-tag size="small" :type="l.toStatus === 'active' ? 'success' : 'warning'">{{ l.fromStatus ?? '∅' }} → {{ l.toStatus }}</el-tag>
                </div>
              </div>
              <p v-else class="fw-text-weak">暂无迁移记录。</p>
            </div>
          </div>
        </template>
        <p v-else-if="saasFailed" class="fw-text-weak">运营总览取数失败（点击各运营页查看实时数据）。</p>
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

.fw-saas-body {
  min-height: 120px;
}

.fw-saas-status-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.fw-saas-status-card {
  padding: 12px;
  border: 1px solid var(--fw-border);
  border-radius: 8px;
  text-align: center;
  cursor: pointer;
}

.fw-saas-status-card:hover {
  border-color: var(--el-color-primary);
}

.fw-saas-status-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.fw-saas-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}

.fw-saas-sub-title {
  margin: 0 0 8px;
  font-size: 14px;
}

.fw-saas-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fw-saas-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--fw-border);
  border-radius: 6px;
  cursor: pointer;
}

.fw-saas-item:hover {
  border-color: var(--el-color-primary);
}

.fw-saas-item-main {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fw-saas-ratio {
  flex: 1;
}
</style>

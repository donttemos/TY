/*
 * @file 租户上下文路由参数（M14/PRD-014 FR-14-14 跨页闭环；OQ-14-4 定案：路由 query 承载）
 * @description 订阅 / 用量 / 生命周期三页统一从 `?tenantId=` 初始化租户上下文，替代「运营人员从工作台
 *   点进来还要再选一次租户」的断链：
 *   ① 首屏命中参数 → 以该租户自动取数（不要求二次点击）；参数缺失 → 只复位、**不发任何请求**；
 *   ② 浏览器前进/后退或外部跳转改变参数 → 同一实例内跟随（onTenant/onEmpty 再触发一次）；
 *   ③ 参数非法（空串、纯空白、数组取首项、非字符串）一律按「无租户」处理，避免用脏值拼出
 *      `/saas/tenants//quotas` 这类必错请求（FR-14-04 参数缺失零查询）。
 *
 *   **为什么只读不写回**（页面内换租户不回写 URL）：AppMain 的 keep-alive 以 `route.fullPath` 作 key
 *   （layout/AppMain.vue `viewKey`），同路由仅 query 变化即重建页面实例。若在选择器里回写 query，
 *   在途实例与新实例会各取一次数，且旧实例会把数据刷成新租户——回退到该 fullPath 时复用缓存实例即
 *   展示错租户数据（FR-14-04 数据隔离的直接破坏）。因此 URL 只作**输入**；如需页面内也改 URL，必须
 *   同时把 keep-alive key 换成 route.path 并让本 composable 独占取数，二者不可只做一半。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/composables
 */

import { onActivated, onDeactivated, onMounted, ref, watch, type Ref } from 'vue';
import { useRoute } from 'vue-router';

/** tenantId 的 query 键名（与工作台三处跳转、api-spec 无关联，纯前端约定） */
export const TENANT_QUERY_KEY = 'tenantId';

/**
 * 归一化路由 query 里的租户标识：数组取首个字符串、非字符串/空白一律空串。
 * 空串语义 = 「路由未提供租户」，调用方不得据此发请求。
 */
export function normalizeTenantId(raw: unknown): string {
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === 'string' ? first.trim() : '';
}

export interface UseTenantQueryOptions {
  /** query 键名，默认 TENANT_QUERY_KEY（tenantId） */
  param?: string;
  /** 路由提供了非空租户：首屏挂载与前进/后退均会触发，由页面决定取数动作 */
  onTenant: (tenantId: string) => void | Promise<void>;
  /** 路由没有（或不再有）租户：只做本地复位，**不得发起查询** */
  onEmpty?: () => void;
}

export interface UseTenantQueryResult {
  /** 当前租户（首屏取路由值，供 TenantPicker v-model 直接绑定） */
  tenantId: Ref<string>;
}

/**
 * 把路由 query 的 tenantId 接到页面租户上下文上。
 * 注意：页面选择器改写 `tenantId` 是合法的（本地筛选态），composable 只在 **路由值变化** 时回调。
 */
export function useTenantQuery(options: UseTenantQueryOptions): UseTenantQueryResult {
  const route = useRoute();
  const param = options.param ?? TENANT_QUERY_KEY;
  const readRouteTenant = (): string => normalizeTenantId(route.query[param]);

  const tenantId = ref(readRouteTenant());
  const ownPath = route.path;
  /** keep-alive 停用后不再跟随路由（否则被替换的旧实例会用新租户取数并污染自己的缓存） */
  const active = ref(true);
  onActivated(() => {
    active.value = true;
  });
  onDeactivated(() => {
    active.value = false;
  });

  // post flush：同路由换参时先让渲染完成（旧实例被 onDeactivated 置为 inactive），再决定是否跟随，
  // 避免「旧实例抢跑取数」。跨路由跳转另有 ownPath 兜底（用法页 → 生命周期页不留串数据）。
  watch(
    readRouteTenant,
    (next) => {
      if (!active.value) return;
      if (route.path !== ownPath) return;
      if (next === tenantId.value) return; // 与本地一致（选择器已选）→ 不重复取数
      tenantId.value = next;
      if (next) void options.onTenant(next);
      else options.onEmpty?.();
    },
    { flush: 'post' },
  );

  onMounted(() => {
    tenantId.value = readRouteTenant();
    if (tenantId.value) void options.onTenant(tenantId.value);
    else options.onEmpty?.();
  });

  return { tenantId };
}

/*
 * @file 平台审计租户名称目录（受控查询 + 批量解析）
 * @description 解决平台审计页的租户名称显示与筛选的两个问题（P2 评审）：
 *   ① 不再一次性调用管理面 `GET /tenants?pageSize=100`——租户超过 100 时后续页既不能筛选、
 *      行内名称也会退化成裸 ID；改为按**当前页行 ID 批量解析**（`ids` 模式，每批 ≤100），
 *      以及筛选下拉的远程搜索（`keyword` 模式）。
 *   ② 不再要求平台审计角色持有 `tenant:read`——受控端点只返回 id / code / name / status，
 *      权限与 `platform*` 维护入口一致（audit:read + system:tenant:ignore）。
 *   名称解析失败不阻塞列表：行内回退「租户 ID」，筛选仍可远程搜索；错误由请求层统一 toast。
 * @author donttemo
 * @created 2026-10-21
 * @module admin-web/composables
 */

import { ref } from 'vue';
import { fetchAuditTenantOptions } from '@/api/audit';
import type { AuditTenantOption } from '@/api/types';

/** 单次 ids 批量解析上限（与服务端 TENANT_OPTION_IDS_MAX 同口径） */
const MAX_IDS_PER_REQUEST = 100;

export function useAuditTenantDirectory() {
  /** 租户 ID → 名称（只缓存解析成功的项；失败时不写假名称） */
  const names = ref<Record<string, string>>({});
  const resolving = ref(false);

  /**
   * 租户显示名：'0' 按契约读作「未知/存量」，未解析到回退「租户 <id>」，绝不冒充某个租户
   * @param tenantId 记录 tenantId
   */
  function nameOf(tenantId: string | null | undefined): string {
    const id = tenantId ?? '0';
    if (id === '0') return '未知/存量';
    return names.value[id] ?? `租户 ${id}`;
  }

  /**
   * 按行内 tenantId 批量解析名称（去重 + 过滤 legacy 0 + 分批 ≤100）
   *
   * 只解析「当前页出现且尚未缓存」的 ID：租户总量不影响查询成本，也不会因分页而漏名称。
   * @param tenantIds 当前页记录的 tenantId 列表
   */
  async function resolveIds(tenantIds: Array<string | null | undefined>): Promise<void> {
    const missing = [
      ...new Set(tenantIds.filter((id): id is string => typeof id === 'string' && id !== '' && id !== '0' && names.value[id] === undefined)),
    ];
    if (missing.length === 0) return;
    resolving.value = true;
    try {
      for (let index = 0; index < missing.length; index += MAX_IDS_PER_REQUEST) {
        const chunk = missing.slice(index, index + MAX_IDS_PER_REQUEST);
        const page = await fetchAuditTenantOptions({ ids: chunk.join(','), page: 1, pageSize: MAX_IDS_PER_REQUEST });
        const next = { ...names.value };
        for (const option of page.items) next[option.id] = option.name;
        names.value = next;
      }
    } catch {
      // 名称解析失败不阻塞列表：行内回退「租户 ID」，筛选仍可远程搜索
    } finally {
      resolving.value = false;
    }
  }

  /** TenantPicker 远程搜索适配器（keyword 为空时取首页候选） */
  async function search(keyword: string): Promise<AuditTenantOption[]> {
    const page = await fetchAuditTenantOptions({ keyword: keyword || undefined, page: 1, pageSize: 20 });
    return page.items;
  }

  return { names, resolving, nameOf, resolveIds, search };
}

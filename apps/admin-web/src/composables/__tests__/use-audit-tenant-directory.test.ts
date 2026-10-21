/*
 * @file 平台审计租户名称目录单测（P2）
 * @description 锁定四件事：① 行内 tenantId 批量解析去重、过滤 legacy '0'、按 100 分批；
 *   ② 已缓存 ID 不重复请求；③ 解析失败不阻塞（nameOf 回退「租户 ID」）；
 *   ④ 筛选下拉远程搜索走 keyword 模式（受控端点，而不是管理面 /tenants）。
 * @author donttemo
 * @created 2026-10-21
 * @module admin-web/composables
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/audit', () => ({ fetchAuditTenantOptions: vi.fn() }));

import { fetchAuditTenantOptions } from '@/api/audit';
import { useAuditTenantDirectory } from '@/composables/useAuditTenantDirectory';

/** ids 模式返回固定名称；keyword 模式返回一条命中 */
function mockOptions(): void {
  vi.mocked(fetchAuditTenantOptions).mockImplementation(async (query) => {
    const ids = query?.ids ? String(query.ids).split(',') : [];
    const items = ids.map((id) => ({ id, code: `c-${id}`, name: `租户${id}`, status: 1 }));
    return { items, total: items.length, page: 1, pageSize: items.length || 20, hasMore: false };
  });
}

describe('useAuditTenantDirectory（平台审计租户名目录）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOptions();
  });

  it('批量解析：去重 + 过滤 legacy 0 + 只发当前页缺失 ID', async () => {
    const directory = useAuditTenantDirectory();
    await directory.resolveIds(['3', '3', '0', null, undefined, '5', '']);
    expect(fetchAuditTenantOptions).toHaveBeenCalledTimes(1);
    expect(fetchAuditTenantOptions).toHaveBeenCalledWith({ ids: '3,5', page: 1, pageSize: 100 });
    expect(directory.nameOf('3')).toBe('租户3');
    expect(directory.nameOf('5')).toBe('租户5');
  });

  it('缓存命中不重复请求；legacy 0 与缺失 ID 有明确回退文案', async () => {
    const directory = useAuditTenantDirectory();
    await directory.resolveIds(['3']);
    await directory.resolveIds(['3']);
    expect(fetchAuditTenantOptions).toHaveBeenCalledTimes(1);
    expect(directory.nameOf('0')).toBe('未知/存量');
    expect(directory.nameOf(null)).toBe('未知/存量');
    expect(directory.nameOf('9')).toBe('租户 9');
  });

  it('超过 100 个 ID 分批请求（每批 ≤100）', async () => {
    const directory = useAuditTenantDirectory();
    const ids = Array.from({ length: 150 }, (_, index) => String(index + 1));
    await directory.resolveIds(ids);
    expect(fetchAuditTenantOptions).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(fetchAuditTenantOptions).mock.calls;
    expect(String(calls[0]![0]?.ids).split(',')).toHaveLength(100);
    expect(String(calls[1]![0]?.ids).split(',')).toHaveLength(50);
  });

  it('解析失败不阻塞：nameOf 回退「租户 ID」，resolving 复位', async () => {
    vi.mocked(fetchAuditTenantOptions).mockRejectedValue(new Error('boom'));
    const directory = useAuditTenantDirectory();
    await expect(directory.resolveIds(['7'])).resolves.toBeUndefined();
    expect(directory.nameOf('7')).toBe('租户 7');
    expect(directory.resolving.value).toBe(false);
  });

  it('远程搜索走 keyword 模式（空关键词归一为 undefined）', async () => {
    vi.mocked(fetchAuditTenantOptions).mockResolvedValue({
      items: [{ id: '3', code: 'dedicated', name: '独立库租户', status: 1 }],
      total: 1,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
    const directory = useAuditTenantDirectory();
    const options = await directory.search('acme');
    expect(fetchAuditTenantOptions).toHaveBeenCalledWith({ keyword: 'acme', page: 1, pageSize: 20 });
    expect(options).toHaveLength(1);
    await directory.search('');
    expect(fetchAuditTenantOptions).toHaveBeenLastCalledWith({ keyword: undefined, page: 1, pageSize: 20 });
  });
});

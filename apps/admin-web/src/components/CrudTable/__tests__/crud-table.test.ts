/*
 * @file CrudTable 组件单元测试
 * @description 覆盖标准 CRUD 组件（PRD-005 FR-09）核心行为：四态渲染（列表 / 空 / 错误 / 无权限）、
 *   权限按钮显隐（无 permission 前缀放行、有前缀按 user store 权限码过滤）、
 *   查询参数拼装（分页 + 固定 filters）、错误态 traceId 展示。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo N-03：补 3002 无权限整页视图断言（出现 / 不误报「加载失败」/ 恢复路径），
 *   并做反向验证——非 3002 错误码不得落入无权限视图
 * @module admin-web/components
 */

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { PagePayload } from '@/components/CrudTable/types';
import { BIZ_CODE, BizError } from '@/utils/biz-error';
import { useUserStore } from '@/store/user';

// 请求层 mock：保留 BizError / describeBizError 真实实现，仅替换 request 四方法
vi.mock('@/utils/request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/request')>();
  return {
    ...actual,
    request: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  };
});

// vue-router mock：CrudTable 仅用 useRoute 生成列设置存储键
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/system/users' }),
  useRouter: () => ({ push: vi.fn() }),
}));

const { request } = await import('@/utils/request');
const CrudTable = (await import('../index.vue')).default;

const mockedGet = vi.mocked(request.get);

function pagePayload(items: Record<string, unknown>[], total = items.length): PagePayload<Record<string, unknown>> {
  return { items, total, page: 1, pageSize: 20, hasMore: false };
}

const COLUMNS = [
  { prop: 'username', label: '账号' },
  { prop: 'nickname', label: '昵称' },
];

const DICT_COLUMNS = [
  { prop: 'label', label: '标签' },
  { prop: 'value', label: '值' },
];

function mountTable(permission?: string) {
  return mount(CrudTable, {
    props: {
      api: '/users',
      columns: COLUMNS,
      permission,
      formFields: [{ prop: 'nickname', label: '昵称', type: 'input' }],
    },
  });
}

describe('CrudTable 四态与权限', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockedGet.mockReset();
    localStorage.clear();
  });

  it('列表态：拉取数据并渲染行，分页参数透传', async () => {
    mockedGet.mockResolvedValue(pagePayload([{ id: '1', username: 'admin', nickname: '管理员' }], 1));
    const wrapper = mountTable('user');

    await flushPromises();
    expect(mockedGet).toHaveBeenCalledWith('/users', { params: { page: 1, pageSize: 20 } });
    expect(wrapper.text()).toContain('admin');
    expect(wrapper.text()).toContain('管理员');
    expect(wrapper.text()).toContain('共 1 条');
  });

  it('空态：无数据时展示空态与「立即新建」', async () => {
    mockedGet.mockResolvedValue(pagePayload([]));
    const user = useUserStore();
    user.permissions = ['user:create'];
    const wrapper = mountTable('user');
    await flushPromises();
    expect(wrapper.text()).toContain('暂无数据');
    expect(wrapper.text()).toContain('立即新建');
  });

  it('错误态：BizError 展示可读信息与 traceId', async () => {
    mockedGet.mockRejectedValue(new BizError(BIZ_CODE.INTERNAL, '', 'trace-xyz-789'));
    const wrapper = mountTable('user');
    await flushPromises();
    expect(wrapper.text()).toContain('加载失败');
    expect(wrapper.text()).toContain('trace-xyz-789');
  });

  it('无权限态（N-03）：列表 3002 整页替换为无权限视图，不落「加载失败」', async () => {
    mockedGet.mockRejectedValue(new BizError(BIZ_CODE.FORBIDDEN, '', 'trace-forbid-1'));
    const wrapper = mountTable('user');
    await flushPromises();
    expect(wrapper.text()).toContain('403');
    expect(wrapper.text()).toContain('无权访问该页面数据');
    expect(wrapper.text()).toContain('返回工作台');
    // 3002 是权限判定结论：不得出现「加载失败」与「重试」按钮（重试只会再次 3002）
    expect(wrapper.text()).not.toContain('加载失败');
    expect(wrapper.text()).not.toContain('重试');
  });

  it('反向验证：非 3002 业务错误（如 1003）仍走「加载失败」，不得误报无权限视图', async () => {
    mockedGet.mockRejectedValue(new BizError(BIZ_CODE.CONFLICT, '冲突', 'trace-conflict-1'));
    const wrapper = mountTable('user');
    await flushPromises();
    expect(wrapper.text()).toContain('加载失败');
    expect(wrapper.text()).not.toContain('无权访问该页面数据');
  });

  it('恢复路径：无权限后重挂载重拉成功，无权限视图退场、表格回归', async () => {
    mockedGet.mockRejectedValueOnce(new BizError(BIZ_CODE.FORBIDDEN, '', 'trace-forbid-2'));
    const wrapper = mountTable('user');
    await flushPromises();
    expect(wrapper.text()).toContain('403');
    wrapper.unmount();

    // fetchList 每次进入都会重置 forbidden/error：同一实例重拉成功即退场（此处经重挂载覆盖同一路径）
    mockedGet.mockResolvedValue(pagePayload([{ id: '1', username: 'admin', nickname: '管理员' }], 1));
    const wrapper2 = mountTable('user');
    await flushPromises();
    expect(wrapper2.text()).toContain('admin');
    expect(wrapper2.text()).not.toContain('无权访问该页面数据');
  });

  it('权限：持有 user:create 才渲染「新建」按钮', async () => {
    mockedGet.mockResolvedValue(pagePayload([{ id: '1', username: 'admin' }]));
    const user = useUserStore();
    user.permissions = ['user:read'];
    const wrapper = mountTable('user');
    await flushPromises();
    expect(wrapper.text()).not.toContain('+ 新建');

    user.permissions = ['user:read', 'user:create'];
    await flushPromises();
    // 权限变化不自动重渲染（按钮在模板中求值），重新挂载验证
    const wrapper2 = mountTable('user');
    await flushPromises();
    expect(wrapper2.text()).toContain('+ 新建');
  });

  it('权限：无 permission 前缀时全部放行', async () => {
    mockedGet.mockResolvedValue(pagePayload([{ id: '1', username: 'admin' }]));
    const wrapper = mountTable();
    await flushPromises();
    expect(wrapper.text()).toContain('+ 新建');
  });

  it('固定 filters 合并进查询参数且不出现在查询区', async () => {
    // 非分页接口（/dict/items、/roles 等）约定返回裸数组（C-06 契约）
    mockedGet.mockResolvedValue([{ id: 'i-1', label: '启用', value: '1' }]);
    const wrapper = mount(CrudTable, {
      props: {
        api: '/dict/items',
        columns: DICT_COLUMNS,
        permission: 'dict',
        pagination: false,
        filters: { category_id: 'c-1' },
      },
    });
    await flushPromises();
    expect(mockedGet).toHaveBeenCalledWith('/dict/items', { params: { category_id: 'c-1' } });
    expect(wrapper.text()).not.toContain('category_id');
    expect(wrapper.text()).toContain('启用');
  });

  it('非分页接口误返回 { items } 时降级取 items（不白屏）', async () => {
    mockedGet.mockResolvedValue(pagePayload([{ id: 'i-2', label: '停用', value: '0' }]));
    const wrapper = mount(CrudTable, {
      props: {
        api: '/dict/items',
        columns: DICT_COLUMNS,
        permission: 'dict',
        pagination: false,
      },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('停用');
  });

  it('loaded 事件：列表加载成功后携带 items/total（供页面按行 tenantId 批量解析名称）', async () => {
    mockedGet.mockResolvedValue(pagePayload([{ id: 'a-1', tenantId: '3' }], 7));
    const wrapper = mountTable('user');
    await flushPromises();
    expect(wrapper.emitted('loaded')?.[0]).toEqual([{ items: [{ id: 'a-1', tenantId: '3' }], total: 7 }]);
  });

  it('filters 变化：回到第一页并以新条件重查（页面级租户选择器切换后列表必须跟随）', async () => {
    mockedGet.mockResolvedValue(pagePayload([{ id: '1', username: 'admin' }], 1));
    const wrapper = mount(CrudTable, {
      props: {
        api: '/audit-logs/platform',
        columns: COLUMNS,
        pagination: true,
        filters: { tenant_id: '1' },
      },
    });
    await flushPromises();
    expect(mockedGet).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ filters: { tenant_id: '3' } });
    await flushPromises();
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(mockedGet).toHaveBeenLastCalledWith('/audit-logs/platform', { params: { page: 1, pageSize: 20, tenant_id: '3' } });
  });
});

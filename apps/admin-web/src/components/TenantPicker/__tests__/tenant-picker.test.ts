/*
 * @file TenantPicker 单测（M14/PRD-014 FR-14-08）
 * @description 钉住远程搜索语义：① 搜索透传 keyword（空关键词 → undefined 取第一页候选）；
 *   ② 查询失败不抛出（选择器不阻断页面）；③ 选中选项 emit update:modelValue（租户 ID）。
 *   真实请求 mock；选项渲染由 Element Plus 提供，不重复断言。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/components
 */
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/api/tenant', () => ({ fetchTenants: vi.fn() }));

import ElementPlus from 'element-plus';
import { fetchTenants } from '@/api/tenant';
import type { TenantView } from '@/api/types';
import TenantPicker from '@/components/TenantPicker/index.vue';

const tenants: TenantView[] = [
  { id: 't1', code: 'acme', name: 'Acme 公司', isolation: 'shared', plan: null, status: 1, expireAt: null, dedicatedDbConfigured: false, createdAt: '', updatedAt: '' },
  { id: 't2', code: 'globex', name: 'Globex', isolation: 'shared', plan: null, status: 1, expireAt: null, dedicatedDbConfigured: false, createdAt: '', updatedAt: '' },
];

function mountPicker(modelValue = '') {
  return mount(TenantPicker, { global: { plugins: [ElementPlus] }, props: { modelValue } });
}

/** 取传给 ElSelect 的 remote-method（搜索逻辑本体） */
function remoteMethodOf(wrapper: ReturnType<typeof mountPicker>): (kw: string) => Promise<void> {
  const select = wrapper.findComponent({ name: 'ElSelect' });
  expect(select.exists()).toBe(true);
  return select.props('remoteMethod') as (kw: string) => Promise<void>;
}

/** 候选最小形状（与组件导出的 TenantPickerOption 同构；测试内自持避免 SFC 类型导入） */
type PickerOption = { id: string; name: string; code: string };

/** 延迟可控的 Promise：用于构造「先发慢、后发快」的乱序返回 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 选择器当前候选（渲染后的 ElOption value 列表，即 binding 的真实结果） */
function optionValuesOf(wrapper: ReturnType<typeof mountPicker>): string[] {
  return wrapper.findAllComponents({ name: 'ElOption' }).map((o) => o.props('value') as string);
}

/** loading 反映「是否有搜索在途」 */
function loadingOf(wrapper: ReturnType<typeof mountPicker>): boolean {
  return wrapper.findComponent({ name: 'ElSelect' }).props('loading') as boolean;
}

describe('TenantPicker（可搜索租户选择器）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchTenants).mockResolvedValue({ items: tenants, total: 2, page: 1, pageSize: 20, hasMore: false });
  });

  it('远程搜索透传 keyword', async () => {
    const wrapper = mountPicker();
    await remoteMethodOf(wrapper)('acme');
    expect(fetchTenants).toHaveBeenCalledWith({ keyword: 'acme', page: 1, pageSize: 20 });
  });

  it('空关键词取第一页候选（keyword 归一为 undefined）', async () => {
    const wrapper = mountPicker();
    await remoteMethodOf(wrapper)('');
    expect(fetchTenants).toHaveBeenCalledWith({ keyword: undefined, page: 1, pageSize: 20 });
  });

  it('查询失败不抛出（选择器不阻断页面）', async () => {
    vi.mocked(fetchTenants).mockRejectedValue(new Error('boom'));
    const wrapper = mountPicker();
    await expect(remoteMethodOf(wrapper)('x')).resolves.toBeUndefined();
  });

  it('选中选项：change → emit update:modelValue（租户 ID）', async () => {
    const wrapper = mountPicker();
    wrapper.findComponent({ name: 'ElSelect' }).vm.$emit('change', 't1');
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['t1']);
  });

  it('注入 fetcher 时走受控查询：不再调用管理面 /tenants（平台审计无需 tenant:read）', async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: '3', code: 'dedicated', name: '独立库租户' }]);
    const wrapper = mount(TenantPicker, {
      global: { plugins: [ElementPlus] },
      props: { modelValue: '', fetcher },
    });
    await remoteMethodOf(wrapper)('dedicated');
    expect(fetcher).toHaveBeenCalledWith('dedicated');
    expect(fetchTenants).not.toHaveBeenCalled();
  });

  it('注入 fetcher 抛错：不向外抛（选择器不阻断页面）', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('audit tenant options down'));
    const wrapper = mount(TenantPicker, {
      global: { plugins: [ElementPlus] },
      props: { modelValue: '', fetcher },
    });
    await expect(remoteMethodOf(wrapper)('x')).resolves.toBeUndefined();
  });
});

describe('TenantPicker 远程搜索并发（请求序号保护）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 连续两次搜索，第一个（旧关键词）慢、第二个（新关键词）快 */
  function mountWithDeferred() {
    const slow = deferred<PickerOption[]>();
    const fast = deferred<PickerOption[]>();
    const fetcher = vi.fn().mockImplementationOnce(() => slow.promise).mockImplementationOnce(() => fast.promise);
    const wrapper = mount(TenantPicker, { global: { plugins: [ElementPlus] }, props: { modelValue: '', fetcher } });
    return { wrapper, slow, fast, fetcher };
  }

  it('旧关键词的慢响应晚到：不覆盖新关键词候选（乱序返回锁定）', async () => {
    const { wrapper, slow, fast } = mountWithDeferred();
    const remote = remoteMethodOf(wrapper);

    const first = remote('ac'); // 旧关键词，慢
    const second = remote('acme'); // 新关键词，快
    fast.resolve([{ id: 't9', code: 'acme', name: 'Acme 新结果' }]);
    await second;
    await nextTick();
    expect(optionValuesOf(wrapper)).toEqual(['t9']);

    slow.resolve([{ id: 't1', code: 'ac-old', name: '旧关键词结果' }]);
    await first;
    await nextTick();
    // 过期响应必须整段丢弃：候选仍与最后一次输入（acme）一致
    expect(optionValuesOf(wrapper)).toEqual(['t9']);
    expect(loadingOf(wrapper)).toBe(false);
  });

  it('旧关键词请求失败晚到：不改候选、不向外抛（过期错误不打扰用户）', async () => {
    const { wrapper, slow, fast } = mountWithDeferred();
    const remote = remoteMethodOf(wrapper);

    const first = remote('ac');
    const second = remote('acme');
    fast.resolve([{ id: 't9', code: 'acme', name: 'Acme 新结果' }]);
    await second;
    await nextTick();

    slow.reject(new Error('stale request failed'));
    await expect(first).resolves.toBeUndefined();
    await nextTick();
    expect(optionValuesOf(wrapper)).toEqual(['t9']);
    expect(loadingOf(wrapper)).toBe(false);
  });

  it('loading 只由最后一次搜索收尾（在途期间保持 true）', async () => {
    const { wrapper, slow, fast } = mountWithDeferred();
    const remote = remoteMethodOf(wrapper);

    const first = remote('ac');
    const second = remote('acme');
    await nextTick();
    expect(loadingOf(wrapper)).toBe(true);

    slow.resolve([{ id: 't1', code: 'ac-old', name: '旧关键词结果' }]);
    await first;
    await nextTick();
    // 旧请求先回（但已被序号判定为过期）：不能提前结束新请求的 loading
    expect(loadingOf(wrapper)).toBe(true);

    fast.resolve([{ id: 't9', code: 'acme', name: 'Acme 新结果' }]);
    await second;
    await nextTick();
    expect(loadingOf(wrapper)).toBe(false);
    expect(optionValuesOf(wrapper)).toEqual(['t9']);
  });
});

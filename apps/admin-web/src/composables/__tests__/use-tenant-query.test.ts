/*
 * @file useTenantQuery 单元测试（M14/PRD-014 跨页闭环）
 * @description 钉住租户上下文路由参数的四个契约：① 首屏命中即回调（自动取数）、参数缺失只回调
 *   onEmpty 且**不取数**；② 浏览器前进/后退（push/go）在同一实例内跟随；③ 参数移除回到无租户态；
 *   ④ 归一化：数组取首项、非字符串/空白视为「未提供」；⑤ 跨路由跳转不串租户（ownPath 守卫）。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/composables
 */

import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import { normalizeTenantId, useTenantQuery, type UseTenantQueryOptions } from '../useTenantQuery';

const Page = { template: '<div />' };

function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/saas/usage', name: 'Usage', component: Page },
      { path: '/saas/lifecycle', name: 'Lifecycle', component: Page },
    ],
  });
}

/** 最小宿主：把 composable 的 tenantId 渲染出来，便于断言初始化值 */
function mountHarness(options: UseTenantQueryOptions) {
  const Harness = defineComponent({
    setup() {
      const { tenantId } = useTenantQuery(options);
      return () => h('span', { class: 'tid' }, tenantId.value);
    },
  });
  return Harness;
}

async function setup(options: UseTenantQueryOptions, path: string) {
  const router = buildRouter();
  await router.push(path);
  await router.isReady();
  const wrapper = mount(mountHarness(options), { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

describe('normalizeTenantId（query 值归一）', () => {
  it('只接受非空字符串；数组取首项；其余视为未提供', () => {
    expect(normalizeTenantId('  t1  ')).toBe('t1');
    expect(normalizeTenantId(['t1', 't2'])).toBe('t1');
    expect(normalizeTenantId('')).toBe('');
    expect(normalizeTenantId('   ')).toBe('');
    expect(normalizeTenantId(undefined)).toBe('');
    expect(normalizeTenantId(null)).toBe('');
    expect(normalizeTenantId(42)).toBe('');
    expect(normalizeTenantId([undefined, 't2'])).toBe('');
  });
});

describe('useTenantQuery（路由租户上下文）', () => {
  it('首屏命中 ?tenantId=：初始化取值并立即回调 onTenant（自动查询）', async () => {
    const onTenant = vi.fn();
    const onEmpty = vi.fn();
    const { wrapper } = await setup({ onTenant, onEmpty }, '/saas/usage?tenantId=t1');

    expect(onTenant).toHaveBeenCalledTimes(1);
    expect(onTenant).toHaveBeenCalledWith('t1');
    expect(onEmpty).not.toHaveBeenCalled();
    expect(wrapper.find('.tid').text()).toBe('t1');
  });

  it('参数缺失/空串：只回调 onEmpty，绝不回调 onTenant（不发错误查询）', async () => {
    const onTenant = vi.fn();
    const onEmpty = vi.fn();
    await setup({ onTenant, onEmpty }, '/saas/usage');
    expect(onTenant).not.toHaveBeenCalled();
    expect(onEmpty).toHaveBeenCalledTimes(1);

    const second = await setup({ onTenant, onEmpty }, '/saas/usage?tenantId=%20%20');
    expect(onTenant).not.toHaveBeenCalled();
    expect(second.wrapper.find('.tid').text()).toBe('');
  });

  it('浏览器前进/后退：同实例跟随新租户', async () => {
    const onTenant = vi.fn();
    const { wrapper, router } = await setup({ onTenant }, '/saas/usage?tenantId=t1');
    expect(onTenant).toHaveBeenLastCalledWith('t1');

    await router.push('/saas/usage?tenantId=t2');
    await flushPromises();
    expect(onTenant).toHaveBeenLastCalledWith('t2');
    expect(wrapper.find('.tid').text()).toBe('t2');

    await router.go(-1);
    await flushPromises();
    expect(onTenant).toHaveBeenLastCalledWith('t1');
    expect(wrapper.find('.tid').text()).toBe('t1');
  });

  it('参数被移除：回调 onEmpty 并清空本地值（不残留上一租户）', async () => {
    const onTenant = vi.fn();
    const onEmpty = vi.fn();
    const { wrapper, router } = await setup({ onTenant, onEmpty }, '/saas/usage?tenantId=t1');

    await router.push('/saas/usage');
    await flushPromises();
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(onTenant).toHaveBeenCalledTimes(1); // 仅首屏那次
    expect(wrapper.find('.tid').text()).toBe('');
  });

  it('跨路由跳转：带 tenantId 的另一页不得让本实例改用该租户取数（不串数据）', async () => {
    const onTenant = vi.fn();
    const { wrapper, router } = await setup({ onTenant }, '/saas/usage?tenantId=t1');

    await router.push('/saas/lifecycle?tenantId=t9');
    await flushPromises();
    expect(onTenant).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.tid').text()).toBe('t1');
  });

  it('数组形式 ?tenantId=a&tenantId=b：取首项', async () => {
    const onTenant = vi.fn();
    const { wrapper } = await setup({ onTenant }, '/saas/usage?tenantId=a&tenantId=b');
    expect(onTenant).toHaveBeenCalledWith('a');
    expect(wrapper.find('.tid').text()).toBe('a');
  });
});

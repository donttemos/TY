/*
 * @file 动态路由注入与布局嵌套 回归护栏
 * @description 覆盖 BUG-16「点击具体功能页后侧边栏消失」：
 *   动态生成的功能页必须作为布局路由的子路由注册，匹配链中必须出现 Layout，
 *   否则渲染的只是 views/layout/blank.vue（纯 router-view），侧边栏 / 顶栏 / 标签页全部丢失。
 *   同时覆盖：静态路由去重（/dashboard 只保留一条）、公开页不挂外壳、兜底路由的 403/404 判定。
 * @author donttemo
 * @created 2026-10-14
 * @module admin-web/router
 */

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { CATCH_ALL_NAME, LAYOUT_ROUTE_NAME, constantRoutes, notFoundRoute } from '../routes';
import { injectDynamicRoutes } from '../inject';
import { resolveFallback, setupRouterGuard } from '../guard';
import { usePermissionStore } from '@/store/permission';
import { useUserStore } from '@/store/user';
import { permission as permissionDirective } from '@/directives/permission';
import type { MeResult, MenuNode } from '@/api/types';

// 认证 API mock：换号登录的守卫用例需控制 /auth/menus 下发内容，且不得发真实请求
vi.mock('@/api/auth', () => ({
  fetchMenus: vi.fn(),
  fetchMe: vi.fn(),
  fetchProfile: vi.fn(),
  updateProfile: vi.fn(),
  fetchSessions: vi.fn(),
  revokeSession: vi.fn(),
  changePassword: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));

// 请求层 mock：挂载真实页面时不应发起网络请求（happy-dom 无服务端，会变成 DNS 报错噪音）
vi.mock('@/utils/request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/request')>();
  return {
    ...actual,
    request: {
      get: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
});

const App = (await import('@/App.vue')).default;

/** 挂载 App 时统一注入路由与产品级的 v-permission 指令（与 main.ts 装配一致） */
function mountApp(router: ReturnType<typeof buildRouter>) {
  return mount(App, {
    global: {
      plugins: [router],
      directives: { permission: permissionDirective },
    },
  });
}

function menu(partial: Partial<MenuNode> & { id: string; name: string }): MenuNode {
  return {
    path: null,
    component: null,
    icon: null,
    permissionCode: null,
    visible: true,
    sort: 1,
    children: [],
    ...partial,
  };
}

/** 镜像 mock/db.ts 与后端 seed 的菜单树（含目录节点 layout/blank 与静态路由重名的 /dashboard） */
const MENUS: MenuNode[] = [
  menu({ id: 'm-dashboard', name: '控制台', path: '/dashboard', component: 'dashboard/index', sort: 1 }),
  menu({
    id: 'm-system',
    name: '系统管理',
    path: '/system',
    component: 'layout/blank',
    sort: 2,
    children: [
      menu({ id: 'm-users', name: '用户管理', path: '/system/users', component: 'system/users', permissionCode: 'user:read', sort: 1 }),
      menu({ id: 'm-roles', name: '角色权限', path: '/system/roles', component: 'system/roles', permissionCode: 'role:read', sort: 2 }),
    ],
  }),
  menu({ id: 'm-demo', name: 'DemoItem管理', path: '/demo-items', component: 'views/demo-item/index', permissionCode: 'demo-item:read', sort: 3 }),
];

/** 构造「已登录 + 已注入动态路由」的完整路由表（复刻 guard.ts 的注入顺序） */
function buildRouter() {
  const permission = usePermissionStore();
  const user = useUserStore();
  permission.menus = MENUS;
  user.permissions = ['user:read', 'role:read', 'demo-item:read'];

  const router = createRouter({ history: createMemoryHistory(), routes: constantRoutes });
  injectDynamicRoutes(router, permission.generateRoutes());
  router.addRoute(notFoundRoute);
  return router;
}

function matchedNames(router: ReturnType<typeof buildRouter>, path: string): (string | undefined)[] {
  return router.resolve(path).matched.map((record) => record.name as string | undefined);
}

describe('动态路由必须嵌套在全局布局内（BUG-16 回归护栏）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('功能页 /system/users 的匹配链包含 Layout（侧边栏不消失）', () => {
    const router = buildRouter();
    const names = matchedNames(router, '/system/users');
    // 渲染层级必须是 Layout → 目录空布局 → 页面，缺 Layout 则外壳整体不挂载
    expect(names).toEqual([LAYOUT_ROUTE_NAME, '/system', '/system/users']);
  });

  it('单层功能页 /demo-items 同样在 Layout 内（生成器落库的 views/<model>/index 亦适用）', () => {
    const router = buildRouter();
    expect(matchedNames(router, '/demo-items')).toEqual([LAYOUT_ROUTE_NAME, '/demo-items']);
  });

  it('/dashboard 与静态路由同路径，不得重复注册（避免匹配歧义）', () => {
    const router = buildRouter();
    const dashboardRecords = router.getRoutes().filter((record) => record.path === '/dashboard');
    expect(dashboardRecords).toHaveLength(1);
    // 静态记录保留（含标签页 affix 语义），且仍在布局内
    expect(dashboardRecords[0]?.meta?.affix).toBe(true);
    expect(matchedNames(router, '/dashboard')).toEqual([LAYOUT_ROUTE_NAME, 'Dashboard']);
  });

  it('标签页「刷新」用的 /redirect 留在布局内（刷新不再卸载侧边栏）', () => {
    const router = buildRouter();
    const names = matchedNames(router, '/redirect/system/users');
    expect(names).toEqual([LAYOUT_ROUTE_NAME, 'Redirect']);
  });

  it('静态路由表内不得存在同名或同路径记录（重名会被 vue-router 静默覆盖，运行时看不出问题）', () => {
    // 断言对象是**静态定义表**而非 router.getRoutes()：vue-router 在注册时会把同名记录静默移除
    // （实测：故意加回重复的 /redirect 后 getRoutes() 里只剩一条）→ 拿解析结果断言等于永真。
    // 真正的风险点在「人手写的这张表」，所以在这里检查。
    interface FlatRecord {
      name?: unknown;
      path: string;
    }
    const flatten = (routes: RouteRecordRaw[], parentPath = ''): FlatRecord[] => {
      const out: FlatRecord[] = [];
      for (const route of routes) {
        const path = route.path.startsWith('/') ? route.path : `${parentPath.replace(/\/$/, '')}/${route.path}`;
        out.push({ name: route.name, path });
        if (route.children?.length) out.push(...flatten(route.children, path));
      }
      return out;
    };
    const flat = flatten(constantRoutes);
    const names = flat.map((r) => r.name).filter((name): name is string => typeof name === 'string');
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    const paths = flat.map((r) => r.path);
    expect(paths.filter((path, index) => paths.indexOf(path) !== index)).toEqual([]);
    // 锁定 /redirect 只存在一条且在布局内（上一轮「移入布局内」只做了一半：新增了布局内记录，漏删顶层记录）
    expect(paths.filter((path) => path.startsWith('/redirect'))).toHaveLength(1);
  });

  it('公开页（登录 / 403 / 404）不挂外壳，无 Layout 祖先', () => {
    const router = buildRouter();
    for (const path of ['/login', '/403', '/404']) {
      expect(matchedNames(router, path)).not.toContain(LAYOUT_ROUTE_NAME);
    }
  });

  it('注入结果：仅注册静态路由未占用的路径，返回实际注册清单', () => {
    setActivePinia(createPinia());
    const permission = usePermissionStore();
    useUserStore().permissions = ['user:read', 'role:read', 'demo-item:read'];
    permission.menus = MENUS;
    const router = createRouter({ history: createMemoryHistory(), routes: constantRoutes });
    const added = injectDynamicRoutes(router, permission.generateRoutes());
    expect(added).toEqual(['/system', '/demo-items']);
    expect(added).not.toContain('/dashboard');
  });
});

describe('换号登录：菜单与路由表必须重建（防上一个账号残留）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('重建时移除上一轮注入的记录，被吊销的页面不再可达', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: constantRoutes });
    router.addRoute(notFoundRoute);

    // 账号 A（有 user:read / role:read / demo-item:read）
    const permission = usePermissionStore();
    const user = useUserStore();
    user.permissions = ['user:read', 'role:read', 'demo-item:read'];
    permission.menus = MENUS;
    const firstRound = injectDynamicRoutes(router, permission.generateRoutes());
    expect(firstRound).toEqual(['/system', '/demo-items']);
    expect(matchedNames(router, '/system/users')).toEqual([LAYOUT_ROUTE_NAME, '/system', '/system/users']);

    // 账号 B（仅登录，无任何业务权限）—— 复刻 guard 在「菜单所属用户变化」时的重建路径
    user.permissions = [];
    permission.menus = [menu({ id: 'm-dashboard', name: '控制台', path: '/dashboard', component: 'dashboard/index' })];
    const secondRound = injectDynamicRoutes(router, permission.generateRoutes(), firstRound);

    expect(secondRound).toEqual([]);
    // A 的页面必须彻底出表 → 命中兜底路由 → 守卫按已知系统路径跳 403（而非静默渲染）
    const matched = router.resolve('/system/users').matched.map((r) => r.name as string | undefined);
    expect(matched).toEqual([CATCH_ALL_NAME]);
    expect(resolveFallback('/system/users', matched)).toBe('/403');
  });

  it('同一账号重复重建是幂等的（不会重复注册 / 不会误删静态路由）', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: constantRoutes });
    const permission = usePermissionStore();
    useUserStore().permissions = ['user:read', 'role:read', 'demo-item:read'];
    permission.menus = MENUS;
    const round1 = injectDynamicRoutes(router, permission.generateRoutes());
    const round2 = injectDynamicRoutes(router, permission.generateRoutes(), round1);

    expect(round2).toEqual(['/system', '/demo-items']);
    expect(router.getRoutes().filter((r) => r.path === '/dashboard')).toHaveLength(1);
    expect(matchedNames(router, '/system/users')).toEqual([LAYOUT_ROUTE_NAME, '/system', '/system/users']);
  });

  it('permission.reset() 保留 injectedRouteNames（否则换号时无从移除旧记录）', () => {
    const permission = usePermissionStore();
    permission.menus = MENUS;
    permission.injectedRouteNames = ['/system'];
    permission.menusOwnerId = 'u-admin';
    permission.routesAdded = true;

    permission.reset();
    expect(permission.menus).toHaveLength(0);
    expect(permission.menusOwnerId).toBeNull();
    expect(permission.routesAdded).toBe(false);
    expect(permission.injectedRouteNames).toEqual(['/system']);
  });
});

describe('真实守卫：登出后换号登录，侧边栏与路由表都归属新账号', () => {
  it('admin 看到的页面在 alice 登录后变为 403（不再继承上一个账号）', async () => {
    setActivePinia(createPinia());
    const router = createRouter({ history: createMemoryHistory(), routes: constantRoutes });
    setupRouterGuard(router);

    const user = useUserStore();
    const permission = usePermissionStore();
    const authApi = await import('@/api/auth');

    const me = (id: string, permissions: string[]): MeResult => ({
      id,
      username: id,
      nickname: id,
      avatar: null,
      roles: [],
      permissions: permissions as MeResult['permissions'],
      dataScope: 'all',
    });

    // ---- 账号 A（admin）登录并访问功能页 ----
    vi.mocked(authApi.fetchMenus).mockResolvedValue(MENUS);
    user.profile = me('u-admin', ['user:read', 'role:read', 'demo-item:read']);
    user.permissions = ['user:read', 'role:read', 'demo-item:read'] as MeResult['permissions'];
    user.isLoggedIn = true;

    await router.push('/system/users');
    expect(router.currentRoute.value.path).toBe('/system/users');
    expect(permission.menusOwnerId).toBe('u-admin');
    expect(permission.visibleMenus().map((m) => m.path)).toEqual(['/dashboard', '/system', '/demo-items']);

    // ---- 登出（user.resetState 不清 permission store，这正是线上路径）----
    user.resetState();
    expect(permission.routesAdded).toBe(true);

    // ---- 账号 B（alice）登录：只有工作台菜单 ----
    vi.mocked(authApi.fetchMenus).mockResolvedValue([
      menu({ id: 'm-dashboard', name: '控制台', path: '/dashboard', component: 'dashboard/index' }),
    ]);
    user.profile = me('u-alice', []);
    user.permissions = [];
    user.isLoggedIn = true;

    // 登录后落到工作台（真实流程：登录成功 → 重定向 /dashboard）；此时守卫检测到换号并重建路由表
    await router.push('/dashboard');
    expect(permission.menusOwnerId).toBe('u-alice');
    expect(permission.injectedRouteNames).toEqual([]);

    // 再直捣 A 的功能页：必须被识别为未授权（403），而不是继续渲染 A 的页面
    expect(router.resolve('/system/users').matched.map((r) => r.name as string | undefined)).toEqual([CATCH_ALL_NAME]);
    await router.push('/system/users');
    expect(router.currentRoute.value.path).toBe('/403');

    // 侧边栏数据也已换成 alice 的（不再残留 admin 的「系统管理」）
    expect(permission.visibleMenus().map((m) => m.path)).toEqual(['/dashboard']);
  });
});

describe('真实挂载：功能页必须渲染出侧边栏（BUG-16 端到端护栏）', () => {
  it('访问 /system/users 时 .fw-sidebar 存在（布局未被顶掉）', async () => {
    setActivePinia(createPinia());
    const router = buildRouter();
    await router.push('/system/users');
    await router.isReady();

    const wrapper = mountApp(router);
    await flushPromises();

    // 侧边栏 / 顶栏 / 标签页都在，且页面内容确实渲染在布局内
    expect(wrapper.find('.fw-sidebar').exists()).toBe(true);
    expect(wrapper.find('.fw-layout').exists()).toBe(true);
    expect(wrapper.find('.fw-tags').exists()).toBe(true);
  });

  it('登录页等公开页不渲染侧边栏（外壳只属于业务页）', async () => {
    setActivePinia(createPinia());
    const router = buildRouter();
    await router.push('/403');
    await router.isReady();

    const wrapper = mountApp(router);
    await flushPromises();
    expect(wrapper.find('.fw-sidebar').exists()).toBe(false);
  });
});

describe('未匹配路径的 403 / 404 判定（原为死代码）', () => {
  it('命中真实路由 → 放行（返回 null）', () => {
    expect(resolveFallback('/system/users', [LAYOUT_ROUTE_NAME, '/system', '/system/users'])).toBeNull();
  });

  it('命中兜底且属已知系统路径 → 403（无权限的合法页面）', () => {
    expect(resolveFallback('/system/users', [CATCH_ALL_NAME])).toBe('/403');
  });

  it('命中兜底且路径未知 → 404', () => {
    expect(resolveFallback('/not-a-real-page', [CATCH_ALL_NAME])).toBe('/404');
  });

  it('回归护栏：兜底已注册时不能仅凭 matched 非空就放行', () => {
    // 旧实现 `if (resolved.matched.length > 0) return true` 在本输入下会误放行 → 空内容页
    const matched = [CATCH_ALL_NAME];
    expect(matched.length).toBeGreaterThan(0);
    expect(resolveFallback('/system/users', matched)).toBe('/403');
  });
});

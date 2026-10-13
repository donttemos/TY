/*
 * @file 种子数据脚本
 * @description fw db:seed 执行：写入演示条目（M2）+ 鉴权基线数据（M3：权限点 / 角色 / 菜单 / 账号 / 授权）。
 *   幂等策略：先按外键依赖倒序清场，再全量重建（可重复执行）。
 *   权限码与角色码直接引用 @fw/auth 的 PERM / ROLE 常量，保证与框架、API 规格同源（PRD-003 FR-04/FR-09）。
 *   口令统一用 PasswordService（Argon2id）现场哈希，脚本内不出现明文入库。
 * @author donttemo
 * @created 2026-10-12
 * @modified 2026-10-13 donttemo M3：扩展为鉴权基线种子（权限点/角色/菜单/账号/授权），并保持幂等
 * @modified 2026-10-13 donttemo M6：追加生成器产物（prisma/seed/demo-item.seed.ts 的 4 个权限点 + 1 条菜单），并给 admin 显式授权
 * @module example-api
 */

// 装饰器元数据 polyfill：@fw/auth 顶层导入了 NestJS 装饰器，必须在它之前加载
import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { PERM, ROLE, PasswordService } from '@fw/auth';
import { seedDemoItemPermissions } from './seed/demo-item.seed.js';

const prisma = new PrismaClient();
const passwords = new PasswordService();

/** 演示种子数据（M2 验收载体） */
const SEED_ITEMS = [
  { title: '欢迎使用通用应用框架' },
  { title: 'M2 数据库抽象已就绪' },
  { title: 'M3 鉴权与权限已就绪（RBAC）' },
];

/** 权限点定义：编码 / 名称 / 类型 / 所属模块（module 用于后台授权页分组） */
interface PermissionSeed {
  code: string;
  name: string;
  type: 'menu' | 'button' | 'api';
  module: string;
}

/** 框架内置权限点（与 @fw/auth 的 PERM 同源） */
const FRAMEWORK_PERMISSIONS: PermissionSeed[] = [
  { code: PERM.AUTH_LOGOUT, name: '登出', type: 'api', module: 'auth' },
  { code: PERM.AUTH_ME, name: '查看当前用户', type: 'api', module: 'auth' },
  { code: PERM.AUTH_CHANGE_PASSWORD, name: '修改本人密码', type: 'api', module: 'auth' },
  { code: PERM.USER_READ, name: '用户查询', type: 'api', module: 'user' },
  { code: PERM.USER_CREATE, name: '用户新增', type: 'api', module: 'user' },
  { code: PERM.USER_UPDATE, name: '用户修改', type: 'api', module: 'user' },
  { code: PERM.USER_DELETE, name: '用户删除', type: 'api', module: 'user' },
  { code: PERM.USER_ASSIGN_ROLE, name: '分配角色', type: 'api', module: 'user' },
  { code: PERM.USER_RESET_PASSWORD, name: '重置他人密码', type: 'api', module: 'user' },
  { code: PERM.ROLE_READ, name: '角色查询', type: 'api', module: 'role' },
  { code: PERM.ROLE_CREATE, name: '角色新增', type: 'api', module: 'role' },
  { code: PERM.ROLE_UPDATE, name: '角色修改', type: 'api', module: 'role' },
  { code: PERM.ROLE_DELETE, name: '角色删除', type: 'api', module: 'role' },
  { code: PERM.ROLE_GRANT, name: '角色授权', type: 'api', module: 'role' },
  { code: PERM.PERMISSION_READ, name: '权限点查询', type: 'api', module: 'permission' },
  { code: PERM.MENU_READ, name: '菜单查询', type: 'menu', module: 'menu' },
  { code: PERM.MENU_CREATE, name: '菜单新增', type: 'menu', module: 'menu' },
  { code: PERM.MENU_UPDATE, name: '菜单修改', type: 'menu', module: 'menu' },
  { code: PERM.MENU_DELETE, name: '菜单删除', type: 'menu', module: 'menu' },
  { code: PERM.AUDIT_READ, name: '审计日志查询', type: 'api', module: 'audit' },
];

/** 业务权限点：演示「未授权则菜单不可见 / 接口 3002」（PRD-003 FR-09） */
const BUSINESS_PERMISSIONS: PermissionSeed[] = [
  { code: 'order:read', name: '订单查询', type: 'menu', module: 'order' },
  { code: 'order:refund', name: '订单退款', type: 'button', module: 'order' },
];

/** M6 生成器写入的权限点编码（与 prisma/seed/demo-item.seed.ts 的 PERMISSIONS 一一对应） */
const GENERATED_PERMISSION_CODES: string[] = [
  'demo-item:create',
  'demo-item:read',
  'demo-item:update',
  'demo-item:delete',
];

/** 普通用户角色默认持有的权限（刻意不含 role:read / audit:read / user:assign-role，用于验证越权拦截） */
const USER_ROLE_CODES: string[] = [
  PERM.AUTH_LOGOUT,
  PERM.AUTH_ME,
  PERM.AUTH_CHANGE_PASSWORD,
  PERM.USER_READ,
];

/** 菜单定义：name / path / component / icon / 所需权限码 / 排序 / 子菜单 */
interface MenuSeed {
  name: string;
  path: string;
  component: string;
  icon: string;
  permissionCode: string | null;
  sort: number;
  children?: MenuSeed[];
}

/** 菜单树（后台动态路由数据源，登录后按权限过滤） */
const MENU_TREE: MenuSeed[] = [
  {
    name: '控制台',
    path: '/dashboard',
    component: 'dashboard/index',
    icon: 'home',
    permissionCode: null, // 登录即可见
    sort: 1,
  },
  {
    name: '系统管理',
    path: '/system',
    component: 'layout/blank',
    icon: 'setting',
    permissionCode: null,
    sort: 2,
    children: [
      { name: '用户管理', path: '/system/users', component: 'system/users', icon: 'user', permissionCode: PERM.USER_READ, sort: 1 },
      { name: '角色权限', path: '/system/roles', component: 'system/roles', icon: 'shield', permissionCode: PERM.ROLE_READ, sort: 2 },
      { name: '审计日志', path: '/system/audit-logs', component: 'system/audit-logs', icon: 'file-text', permissionCode: PERM.AUDIT_READ, sort: 3 },
    ],
  },
  {
    name: '订单中心',
    path: '/order',
    component: 'layout/blank',
    icon: 'shopping',
    permissionCode: 'order:read',
    sort: 3,
    children: [
      { name: '订单退款', path: '/order/refund', component: 'order/refund', icon: 'money', permissionCode: 'order:refund', sort: 1 },
    ],
  },
];

/** 清场顺序：外键依赖倒序（关联表 → 主表 → 演示表 → 租户） */
async function truncate(): Promise<void> {
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.menu.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.user.deleteMany();
  await prisma.demoItem.deleteMany();
  await prisma.tenant.deleteMany();
}

/**
 * 写入租户基线（M8，PRD-008 FR-01）：
 * - legacy（id '0'）：存量单租户数据的归属租户，种子账号默认 tenantId=0 全部落在此租户；
 * - acme（id '1'）：演示「子域名解析」与跨租户越权用例的第二个租户；
 * - off（id '2'）：停用租户，验证 fail-closed（403）。
 */
async function seedTenants(): Promise<void> {
  const rows = [
    { id: '0', code: 'legacy', name: '存量单租户', isolation: 'shared', status: 1 },
    { id: '1', code: 'acme', name: 'ACME 公司', isolation: 'shared', status: 1 },
    { id: '2', code: 'off', name: '已停用租户', isolation: 'shared', status: 0 },
  ];
  for (const row of rows) {
    await prisma.tenant.create({ data: row });
  }
}

/** 写入权限点，返回 code → id 映射 */
async function seedPermissions(): Promise<Map<string, string>> {
  const all = [...FRAMEWORK_PERMISSIONS, ...BUSINESS_PERMISSIONS];
  const idByCode = new Map<string, string>();
  let sort = 0;
  for (const item of all) {
    const row = await prisma.permission.create({
      data: { code: item.code, name: item.name, type: item.type, module: item.module, sort: sort++ },
    });
    idByCode.set(item.code, row.id);
  }
  return idByCode;
}

/** 递归写入菜单，返回根节点数量 */
async function seedMenus(parentId: string, items: MenuSeed[], counter: { count: number }): Promise<void> {
  let sort = 0;
  for (const item of items) {
    const row = await prisma.menu.create({
      data: {
        parentId,
        name: item.name,
        path: item.path,
        component: item.component,
        icon: item.icon,
        permissionCode: item.permissionCode,
        visible: 1,
        sort: item.sort || ++sort,
      },
    });
    counter.count += 1;
    if (item.children?.length) await seedMenus(row.id, item.children, counter);
  }
}

async function main(): Promise<void> {
  await truncate();

  // 0) M8 租户基线（先建租户，账号 tenantId 依赖其 ID 语义）
  await seedTenants();

  // 1) M2 演示条目
  for (const item of SEED_ITEMS) {
    await prisma.demoItem.create({ data: item });
  }

  // 2) 权限点
  const permIdByCode = await seedPermissions();

  // 3) 角色（dataScope：admin=all，user=self）
  const adminRole = await prisma.role.create({
    data: { code: ROLE.ADMIN, name: '超级管理员', remark: '内置角色，拥有全部权限', isSystem: 1, dataScope: 'all', sort: 1 },
  });
  const userRole = await prisma.role.create({
    data: { code: ROLE.USER, name: '普通用户', remark: '内置角色，仅自身相关', isSystem: 1, dataScope: 'self', sort: 2 },
  });

  // 4) 授权：admin 全量；user 最小集
  for (const permissionId of permIdByCode.values()) {
    await prisma.rolePermission.create({ data: { roleId: adminRole.id, permissionId } });
  }
  for (const code of USER_ROLE_CODES) {
    await prisma.rolePermission.create({ data: { roleId: userRole.id, permissionId: permIdByCode.get(code) as string } });
  }

  // 5) 菜单
  const menuCounter = { count: 0 };
  await seedMenus('0', MENU_TREE, menuCounter);

  // 6) M6 生成器产物：权限点 + 菜单（幂等 upsert；truncate 之后执行，admin 显式授权后后台角色配置页可见）
  await seedDemoItemPermissions();
  for (const code of GENERATED_PERMISSION_CODES) {
    const permission = await prisma.permission.findUnique({ where: { code } });
    if (permission) {
      await prisma.rolePermission.create({ data: { roleId: adminRole.id, permissionId: permission.id } });
    }
  }

  // 7) 账号（Argon2id 现场哈希）
  const adminPassword = 'Admin@123456';
  const userPassword = 'Alice@123456';
  const admin = await prisma.user.create({
    data: {
      username: 'admin',
      passwordHash: await passwords.hash(adminPassword),
      nickname: '管理员',
      email: 'admin@example.com',
      status: 1,
    },
  });
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      passwordHash: await passwords.hash(userPassword),
      nickname: 'Alice',
      email: 'alice@example.com',
      status: 1,
    },
  });
  // M8：acme 租户管理员（tenantId=1，用于子域名解析与跨租户越权用例）
  const acmePassword = 'Acme@123456';
  await prisma.user.create({
    data: {
      username: 'acmeadmin',
      tenantId: 1n,
      passwordHash: await passwords.hash(acmePassword),
      nickname: 'ACME 管理员',
      email: 'acmeadmin@acme.example.com',
      status: 1,
    },
  });

  // 8) 用户-角色（acmeadmin 与 alice 同权，角色归属第 5 步的 userRole）
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
  await prisma.userRole.create({ data: { userId: alice.id, roleId: userRole.id } });
  const acmeUser = await prisma.user.findUnique({ where: { username: 'acmeadmin' } });
  if (acmeUser) await prisma.userRole.create({ data: { userId: acmeUser.id, roleId: userRole.id } });

  console.log(
    [
      '[seed] 完成：',
      `演示条目 ${SEED_ITEMS.length} 条`,
      `权限点 ${permIdByCode.size + GENERATED_PERMISSION_CODES.length} 个（框架/业务 ${permIdByCode.size} + 生成器 ${GENERATED_PERMISSION_CODES.length}）`,
      `角色 2 个（${ROLE.ADMIN} 全量 / ${ROLE.USER} ${USER_ROLE_CODES.length} 项）`,
      `菜单 ${menuCounter.count} 项`,
      `账号 2 个（admin / ${adminPassword}，alice / ${userPassword}）+ acmeadmin / ${acmePassword}（tenantId=1）`,
      `租户 3 个（legacy=0 / acme=1 / off=2 停用）`,
    ].join(' '),
  );
}

main()
  .catch((error: unknown) => {
    console.error('[seed] 失败:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

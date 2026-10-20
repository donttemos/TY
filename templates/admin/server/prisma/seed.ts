/*
 * @file 种子数据脚本（admin 模板）
 * @description fw db:seed 执行：写入 RBAC 基线（权限点 / 角色 / 菜单 / 字典 / 账号 / 部门）
 *   + 示例条目 + 生成器产物权限（demo-item.seed）。幂等策略：先按外键依赖倒序清场，再全量重建。
 *   权限码与角色码直接引用 @fw/auth 的 PERM / ROLE 常量，保证与框架同源；
 *   口令统一用 PasswordService（Argon2id）现场哈希，脚本内不出现明文入库。
 *   默认账号：admin / Admin@123456（超管）、alice / Alice@123456（普通用户）、
 *   bob / Bob@123456（部门负责人，org_below 数据范围示范）——首次登录后请立即改密。
 * @author donttemo
 * @created 2026-10-15
 * @module __APP_NAME__
 */

// 装饰器元数据 polyfill：@fw/auth 顶层导入了 NestJS 装饰器，必须在它之前加载
import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { PERM, ROLE, PasswordService } from '@fw/auth';
import { seedDemoItemPermissions } from './seed/demo-item.seed.js';

const prisma = new PrismaClient();
const passwords = new PasswordService();

/** 演示种子数据 */
const SEED_ITEMS = [
  { title: '欢迎使用通用应用框架' },
  { title: 'admin 模板：登录 + RBAC + 示例 CRUD 已就绪' },
  { title: '附件上传已就绪（POST /api/v1/files）' },
];

/** 权限点定义：编码 / 名称 / 类型 / 所属模块（module 用于后台授权页分组） */
interface PermissionSeed {
  code: string;
  name: string;
  type: 'menu' | 'button' | 'api';
  module: string;
}

/** 框架内置权限点（与 @fw/auth 的 PERM 同源；模板未接入的功能面不下发权限点） */
const FRAMEWORK_PERMISSIONS: PermissionSeed[] = [
  { code: PERM.AUTH_LOGOUT, name: '登出', type: 'api', module: 'auth' },
  { code: PERM.AUTH_ME, name: '查看当前用户', type: 'api', module: 'auth' },
  { code: PERM.AUTH_CHANGE_PASSWORD, name: '修改本人密码', type: 'api', module: 'auth' },
  { code: PERM.AUTH_REVOKE_SESSION, name: '下线登录设备', type: 'api', module: 'auth' },
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
  { code: PERM.DICT_READ, name: '字典查询', type: 'api', module: 'dict' },
  { code: PERM.DICT_WRITE, name: '字典维护', type: 'api', module: 'dict' },
  // 附件上传（admin 模板 upload 端点守卫）
  { code: 'file:create', name: '附件上传', type: 'api', module: 'file' },
];

/** M6 生成器写入的权限点编码（与 prisma/seed/demo-item.seed.ts 的 PERMISSIONS 一一对应） */
const GENERATED_PERMISSION_CODES: string[] = [
  'demo-item:create',
  'demo-item:read',
  'demo-item:update',
  'demo-item:delete',
];

/** 普通用户角色默认持有的权限（刻意不含 role:read / user 写操作，用于验证越权拦截）
 *  dict:read 按「字典是 UI 枚举元数据」的口径授予，缺它普通用户只能看到原始值。 */
const USER_ROLE_CODES: string[] = [
  PERM.AUTH_LOGOUT,
  PERM.AUTH_ME,
  PERM.AUTH_CHANGE_PASSWORD,
  PERM.USER_READ,
  PERM.DICT_READ,
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

/** 菜单树（后台动态路由数据源，登录后按权限过滤；component 相对 admin-web/src） */
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
      { name: '字典管理', path: '/system/dict', component: 'system/dict', icon: 'collection', permissionCode: PERM.DICT_READ, sort: 3 },
    ],
  },
  // DemoItem管理 由 prisma/seed/demo-item.seed.ts（fw gen crud 产物）幂等写入，此处不重复声明
];

/** 清场顺序：外键依赖倒序（关联表 → 主表 → 业务表） */
async function truncate(): Promise<void> {
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.userDepartment.deleteMany();
  await prisma.menu.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.department.deleteMany();
  await prisma.user.deleteMany();
  await prisma.dictItem.deleteMany();
  await prisma.dictCategory.deleteMany();
  await prisma.demoItem.deleteMany();
  await prisma.uploadFile.deleteMany();
}

/** 字典种子：编码 / 名称 / 项（value 为程序值，label 为展示值，color 供标签取色） */
interface DictSeed {
  code: string;
  name: string;
  remark?: string;
  items: Array<{ label: string; value: string; color?: string }>;
}

/**
 * 字典基线（页面不硬编码枚举）。
 * 编码与前端实际消费点一一对应，缺任一项，对应页面首次渲染即 404（GET /api/v1/dict/:code）。
 */
const DICT_SEED: DictSeed[] = [
  {
    code: 'user_status',
    name: '用户状态',
    remark: '账号启用 / 禁用',
    items: [
      { label: '启用', value: '1', color: 'success' },
      { label: '禁用', value: '0', color: 'danger' },
    ],
  },
  {
    code: 'data_scope',
    name: '数据范围',
    remark: '角色可见数据边界，四档与 roles.data_scope 同源',
    items: [
      { label: '全部数据', value: 'all', color: 'primary' },
      { label: '本部门及下级', value: 'org_below', color: 'warning' },
      { label: '本部门', value: 'org', color: 'warning' },
      { label: '仅本人', value: 'self', color: 'info' },
    ],
  },
  {
    code: 'audit_action',
    name: '审计动作',
    remark: '审计日志 action 字段取值',
    items: [
      { label: '新增', value: 'create', color: 'success' },
      { label: '修改', value: 'update', color: 'warning' },
      { label: '删除', value: 'delete', color: 'danger' },
      { label: '登录', value: 'login', color: 'primary' },
      { label: '登出', value: 'logout', color: 'info' },
      // M15：安全事件（replay / 越权拒绝）在记录层使用 action=security，字典此前缺项
      { label: '安全事件', value: 'security', color: 'danger' },
    ],
  },
  {
    code: 'audit_module',
    name: '审计模块',
    remark: '审计日志 module 字段取值（与各控制器写入值同源）',
    items: [
      { label: '认证', value: 'auth', color: 'primary' },
      { label: '用户', value: 'user', color: 'success' },
      { label: '角色', value: 'role', color: 'warning' },
      { label: '附件', value: 'file', color: 'info' },
    ],
  },
];

/** 写入字典分类与字典项 */
async function seedDicts(): Promise<void> {
  for (const category of DICT_SEED) {
    const row = await prisma.dictCategory.create({
      data: { code: category.code, name: category.name, remark: category.remark ?? null },
    });
    let itemSort = 0;
    for (const item of category.items) {
      await prisma.dictItem.create({
        data: {
          categoryId: row.id,
          label: item.label,
          value: item.value,
          color: item.color ?? null,
          sort: itemSort++,
        },
      });
    }
  }
}

/**
 * 写入组织架构基线（org / org_below 数据范围示范）：
 *   总部(hq)
 *   ├─ 研发部(rd)     ← bob 负责人（org_below：可见 rd + rd-fe + rd-be）
 *   │  ├─ 前端组(rd-fe) ← alice
 *   │  └─ 后端组(rd-be)
 *   └─ 市场部(mkt)    ← 范围外（bob 查询市场部成员应被收敛）
 */
async function seedDepartments(): Promise<Map<string, string>> {
  const rows = [
    { code: 'hq', name: '总部', parent: '0', sort: 1 },
    { code: 'rd', name: '研发部', parent: 'hq', sort: 1 },
    { code: 'rd-fe', name: '前端组', parent: 'rd', sort: 1 },
    { code: 'rd-be', name: '后端组', parent: 'rd', sort: 2 },
    { code: 'mkt', name: '市场部', parent: 'hq', sort: 2 },
  ];
  const idByCode = new Map<string, string>();
  for (const row of rows) {
    const created = await prisma.department.create({
      data: {
        code: row.code,
        name: row.name,
        parentId: row.parent === '0' ? '0' : (idByCode.get(row.parent) as string),
        sort: row.sort,
      },
    });
    idByCode.set(row.code, created.id);
  }
  return idByCode;
}

/** 写入权限点，返回 code → id 映射 */
async function seedPermissions(): Promise<Map<string, string>> {
  const idByCode = new Map<string, string>();
  let sort = 0;
  for (const item of FRAMEWORK_PERMISSIONS) {
    const row = await prisma.permission.create({
      data: { code: item.code, name: item.name, type: item.type, module: item.module, sort: sort++ },
    });
    idByCode.set(item.code, row.id);
  }
  return idByCode;
}

/** 递归写入菜单 */
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

  // 1) 演示条目
  for (const item of SEED_ITEMS) {
    await prisma.demoItem.create({ data: item });
  }

  // 2) 权限点
  const permIdByCode = await seedPermissions();

  // 3) 角色（dataScope：admin=all，user=self；dept_leader=org_below 数据范围示范）
  const adminRole = await prisma.role.create({
    data: { code: ROLE.ADMIN, name: '超级管理员', remark: '内置角色，拥有全部权限', isSystem: 1, dataScope: 'all', sort: 1 },
  });
  const userRole = await prisma.role.create({
    data: { code: ROLE.USER, name: '普通用户', remark: '内置角色，仅自身相关', isSystem: 1, dataScope: 'self', sort: 2 },
  });
  const deptLeaderRole = await prisma.role.create({
    data: { code: 'dept_leader', name: '部门负责人', remark: '示范：本部门及下级数据（org_below）', isSystem: 0, dataScope: 'org_below', sort: 3 },
  });

  // 4) 授权：admin 全量；user 最小集；dept_leader 持 user:read + user:update（差异只在数据范围）
  for (const permissionId of permIdByCode.values()) {
    await prisma.rolePermission.create({ data: { roleId: adminRole.id, permissionId } });
  }
  for (const code of USER_ROLE_CODES) {
    await prisma.rolePermission.create({ data: { roleId: userRole.id, permissionId: permIdByCode.get(code) as string } });
  }
  for (const code of [PERM.USER_READ, PERM.USER_UPDATE]) {
    await prisma.rolePermission.create({ data: { roleId: deptLeaderRole.id, permissionId: permIdByCode.get(code) as string } });
  }

  // 5) 菜单
  const menuCounter = { count: 0 };
  await seedMenus('0', MENU_TREE, menuCounter);

  // 5.5) 字典基线
  await seedDicts();

  // 6) 生成器产物：权限点 + 菜单（幂等 upsert；admin 显式授权后角色配置页可见）
  await seedDemoItemPermissions();
  for (const code of GENERATED_PERMISSION_CODES) {
    const permission = await prisma.permission.findUnique({ where: { code } });
    if (permission) {
      await prisma.rolePermission.create({ data: { roleId: adminRole.id, permissionId: permission.id } });
    }
  }

  // 7) 组织架构（部门树；user_department 在账号就绪后写入）
  const deptIdByCode = await seedDepartments();

  // 8) 账号（Argon2id 现场哈希）
  const adminPassword = 'Admin@123456';
  const userPassword = 'Alice@123456';
  const bobPassword = 'Bob@123456';
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
      nickname: 'Alice（前端组）',
      email: 'alice@example.com',
      status: 1,
    },
  });
  const bob = await prisma.user.create({
    data: {
      username: 'bob',
      passwordHash: await passwords.hash(bobPassword),
      nickname: 'Bob（研发部负责人）',
      email: 'bob@example.com',
      status: 1,
    },
  });

  // 9) 用户-角色 + 用户-部门（is_primary=1 标主部门）
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
  await prisma.userRole.create({ data: { userId: alice.id, roleId: userRole.id } });
  await prisma.userRole.create({ data: { userId: bob.id, roleId: deptLeaderRole.id } });
  await prisma.userDepartment.create({ data: { userId: alice.id, departmentId: deptIdByCode.get('rd-fe') as string, isPrimary: 1 } });
  await prisma.userDepartment.create({ data: { userId: bob.id, departmentId: deptIdByCode.get('rd') as string, isPrimary: 1 } });
  await prisma.department.update({
    where: { id: deptIdByCode.get('rd') as string },
    data: { leaderId: bob.id },
  });

  console.log(
    [
      '[seed] 完成：',
      `演示条目 ${SEED_ITEMS.length} 条`,
      `权限点 ${permIdByCode.size + GENERATED_PERMISSION_CODES.length} 个（框架 ${permIdByCode.size} + 生成器 ${GENERATED_PERMISSION_CODES.length}）`,
      `角色 3 个（${ROLE.ADMIN}=all / ${ROLE.USER}=self / dept_leader=org_below）`,
      `菜单 ${menuCounter.count} 项（+ 生成器 DemoItem管理 1 项）`,
      `字典 ${DICT_SEED.length} 组`,
      `部门 ${deptIdByCode.size} 个`,
      `账号 3 个：admin / ${adminPassword}，alice / ${userPassword}（普通用户），bob / ${bobPassword}（部门负责人）——首次登录后请立即改密`,
    ].join(' '),
  );
}

main()
  .catch((error: unknown) => {
    console.error('[seed] 失败:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

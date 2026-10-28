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
 * @modified 2026-10-13 donttemo M8：新增租户基线（legacy/acme/off）与 acmeadmin 账号
 * @modified 2026-10-14 donttemo M8 T-M8-02：新增 dedicated 独立库租户（db_url_enc 密文）与 dedicatedadmin 账号
 * @modified 2026-10-14 donttemo M8 T-M8-04：新增组织架构种子（部门树 + user_department）与
 *   dept_leader(org_below) / dept_member(org) / self_updater(self) 三角色及示范账号（TC-TNT-004）
 * @modified 2026-10-14 donttemo 真机部署修复（2C2G 云服务器 + PostgreSQL）：① 补种队列管理权限点
 *   system:queue:list / system:queue:manage——M7 的 /api/v1/admin/queue/* 11 个端点全部由这两个权限守卫，
 *   而此前种子从未创建它们，导致连 admin 角色都返回 3002「无操作权限」，该功能面在真实部署中不可达；
 *   ② dedicated 租户的独立库连接串不再写死 sqlite 路径：按 DB_DRIVER 或 SEED_DEDICATED_DB_URL 决定，
 *   非 sqlite 部署下留空（NULL），避免落一个在该部署中永远连不上的密文。
 * @modified 2026-10-14 donttemo 管理后台前端可达性修复：① 补「队列管理」菜单（/system/queue，需
 *   system:queue:list）——上一轮只补了权限点，菜单仍缺，而前端动态路由完全由菜单树生成，
 *   结果 M7 队列管理页在真实部署里既无菜单也无路由（直输 URL 落 403）；
 *   ② 移除死链菜单「订单中心」(/order → order/refund)：该视图与后端 /api/v1/orders 均不存在，
 *   真实部署下必然点击落 404；演示用订单列表页只存在于前端 mock（dev/test），故整支移除，
 *   真实部署的业务菜单示范由 /demo-items 承担（order:read / order:refund 权限点保留，供授权页与前端演示页使用）；
 *   ③ 普通用户角色补 dict:read：状态列 / 下拉全站走 useDict，缺该权限时普通用户只能看到原始值（0/1）而非「启用/禁用」
 * @modified 2026-10-15 donttemo N-01/N-02：① 补租户管理五权限点（tenant:read/create/update/delete/manage）与
 *   audit:export，并新增「租户管理」菜单（/system/tenants，需 tenant:read）——权限点与菜单同批建出，
 *   否则页面即便有路由也会被 RBAC 守卫拒绝；② 补字典 tenant_isolation / tenant_status（租户管理页标签与下拉数据源）
 * @modified 2026-10-15 donttemo E-07：补字典 audit_module（审计日志页模块筛选项数据源，取值与各控制器
 *   写入的 module 值同源：auth/user/role/tenant）
 * @modified 2026-10-15 donttemo M9/PRD-009：① 补配置中心两权限点（system:config:read/write，api-spec §3.10
 *   端点守卫）与「参数配置」菜单（/system/configs，需 system:config:read）——权限点与菜单同批建出；
 *   ② audit_module 字典补 queue / config 值（队列死信重放与配置变更审计分别以两 module 落盘）
 * @modified 2026-10-15 donttemo M10 E-13：补站内信权限点 notification:read（消息中心六端点守卫，
 *   按「可授予可回收的能力面」口径成码，无菜单——铃铛是顶栏全局元素）并授予 user 与 M8 三示范角色；
 *   清场追加 notifications 表
 * @modified 2026-10-16 donttemo M10 E-09：补附件上传权限点 file:create（POST /api/v1/files 守卫，
 *   按「可授予可回收的能力面」口径成码，无菜单——上传是表单内嵌能力而非路由页）并授予 user 角色；
 *   清场追加 upload_files 表
 * @modified 2026-10-21 donttemo P2 平台审计入口：补「平台审计」菜单（/system/audit-logs/platform，
 *   需 system:tenant:ignore）——前端审计页新增跨租户模式与独立入口，普通审计菜单不受影响；
 *   仅 admin（全量授权）等持有跨租户维护码的角色可见，与本仓库「维护入口 = IgnoreTenant + 同码」口径一致；
 *   同批补「租户审计员」示范角色（tenant_auditor：audit:read + audit:export，dataScope=all，
 *   刻意不含 system:tenant:ignore）与 acme 租户账号 acmeauditor（tenantId=1）——M15 双租户验收的
 *   普通租户管理员侧账号，与 admin（legacy + 平台维护）形成对照
 * @modified 2026-10-21 donttemo 清场范围修复（docs/64 §5 #4 真机观察项）：truncate 追加租户级 SaaS
 *   数据（订阅 / 配额覆盖 / 窗口用量 / 用量事件 / 用量汇总 / 生命周期日志）与归档审计——此前
 *   reseed 只清 tenants，旧订阅的 active_marker 会被新租户 ID 继承，表现为「刚建的租户已有生效
 *   订阅」（开通 1003）、新租户继承旧用量；目录类数据（plans / versions / plan_quotas /
 *   quota_definitions）刻意保留，非租户数据且不产生错误归属
 * @module example-api
 */

// 装饰器元数据 polyfill：@fw/auth 顶层导入了 NestJS 装饰器，必须在它之前加载
import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { PERM, ROLE, PasswordService } from '@fw/auth';
import { QUEUE_PERM_LIST, QUEUE_PERM_MANAGE } from '@fw/queue';
// <fw:gen:seed-imports>
import { seedDemoItemPermissions } from './seed/demo-item.seed.js';
// </fw:gen:seed-imports>
import { encryptDbUrl } from '../src/modules/tenant/db-url-crypto.js';

/**
 * dedicated 租户独立库连接串（T-M8-02）。相对路径按 prisma/schema.prisma 所在目录解析
 * （与主库 DB_URL 同一语义）。
 *
 * ★ 真机部署修复：此前写死为 sqlite 文件 'file:./tenant-dedicated.db'，在 PostgreSQL/MySQL 部署下
 *   会落一个「provider 与连接串不匹配、永远连不上」的密文（Prisma 在 generate 时已固定 provider）。
 *   现改为：优先取环境变量 SEED_DEDICATED_DB_URL；未配置时仅当 DB_DRIVER 为 sqlite（或未设置，
 *   与 env-schema 默认值一致）才回退到本地文件，否则留空——由运维为 dedicated 租户显式配置。
 */
const DEDICATED_DB_URL =
  process.env.SEED_DEDICATED_DB_URL ??
  (!process.env.DB_DRIVER || process.env.DB_DRIVER === 'sqlite' ? 'file:./tenant-dedicated.db' : '');

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
  { code: PERM.AUDIT_EXPORT, name: '审计日志导出', type: 'api', module: 'audit' },
  { code: PERM.DICT_READ, name: '字典查询', type: 'api', module: 'dict' },
  { code: PERM.DICT_WRITE, name: '字典维护', type: 'api', module: 'dict' },
  { code: PERM.AUTH_REVOKE_SESSION, name: '下线登录设备', type: 'api', module: 'auth' },
  // N-01 租户管理（api-spec §3.9）：平台管理员对 tenants 表的读写与隔离级别迁移
  { code: PERM.TENANT_READ, name: '租户查询', type: 'api', module: 'tenant' },
  { code: PERM.TENANT_CREATE, name: '开租户', type: 'api', module: 'tenant' },
  { code: PERM.TENANT_UPDATE, name: '租户修改', type: 'api', module: 'tenant' },
  { code: PERM.TENANT_DELETE, name: '租户停用', type: 'api', module: 'tenant' },
  { code: PERM.TENANT_MANAGE, name: '租户隔离级别迁移', type: 'api', module: 'tenant' },
  // 跨租户维护豁免（@fw/auth 的 @IgnoreTenant）：租户管理端点是平台管理员视角，
  // 必须豁免租户解析（否则 TENANT_ENABLED=true 时自身 4001），守卫要求显式持有本权限并写豁免审计。
  { code: PERM.TENANT_IGNORE, name: '跨租户维护', type: 'api', module: 'tenant' },
  // M9 配置中心（api-spec §3.10）：参数配置页与热更端点的读写守卫（读写分离）
  { code: PERM.CONFIG_READ, name: '参数配置查询', type: 'api', module: 'config' },
  { code: PERM.CONFIG_WRITE, name: '参数配置修改', type: 'api', module: 'config' },
  // M7 队列管理端点（@fw/queue 的 QueueAdminController，路径 /api/v1/admin/queue）的守卫权限。
  // 真机部署修复：缺少这两点会让整个队列管理功能面对任何角色都返回 3002，必须随种子建出并授予 admin。
  { code: QUEUE_PERM_LIST, name: '队列查看', type: 'api', module: 'queue' },
  { code: QUEUE_PERM_MANAGE, name: '队列管理', type: 'api', module: 'queue' },
  // M12 W3 OBS-15（ADR-0027）：/auth-maintenance/* 三端点由类级 @Public 收敛为 ops:read 守卫——
  // maintenance 默认受保护，公开需显式白名单 + 理由 + 契约测试；admin 角色经全量授权自动持有。
  { code: PERM.OPS_READ, name: '运维快照读取', type: 'api', module: 'system' },
  // M13 SaaS 运营面（PRD-013 FR-13-15，api-spec §3.21）：/api/v1/saas/* 平台运营端点。
  // 读写分离；运营面整类 @IgnoreTenant()，与 system:tenant:ignore 组成跨租户维护路径（与关系）。
  // admin 角色经全量授权自动持有；存量环境需 reseed + 重登（登录快照含权限码）。
  { code: PERM.OPS_SAAS_READ, name: 'SaaS 运营查询', type: 'api', module: 'saas' },
  { code: PERM.OPS_SAAS_WRITE, name: 'SaaS 运营操作', type: 'api', module: 'saas' },
  // M10 E-13：站内信消息中心（/api/v1/notifications 六个端点的守卫）。
  // 无对应菜单——铃铛是顶栏全局元素而非路由页；权限点仍显式成码，便于按岗授予 / 回收。
  { code: PERM.NOTIFICATION_READ, name: '消息中心', type: 'api', module: 'notification' },
  // M10 E-09：附件上传（POST /api/v1/files 的守卫）。
  // 无对应菜单——上传是表单内嵌能力（CrudTable 附件字段 / el-upload）而非路由页；元数据与下载登录即可。
  { code: PERM.FILE_CREATE, name: '附件上传', type: 'api', module: 'file' },
];

/** 业务权限点：演示「未授权则菜单不可见 / 接口 3002」（PRD-003 FR-09） */
const BUSINESS_PERMISSIONS: PermissionSeed[] = [
  { code: 'order:read', name: '订单查询', type: 'menu', module: 'order' },
  { code: 'order:refund', name: '订单退款', type: 'button', module: 'order' },
];

/** M6 生成器写入的权限点编码（由 fw gen crud 经清单重建，勿手改块内内容） */
const GENERATED_PERMISSION_CODES: string[] = [
  // <fw:gen:perm-codes>
  'demo-item:create',
  'demo-item:read',
  'demo-item:update',
  'demo-item:delete',
  // </fw:gen:perm-codes>
];

/** 普通用户角色默认持有的权限（刻意不含 role:read / audit:read / user:assign-role，用于验证越权拦截）
 *  dict:read 是例外：全站状态列 / 下拉都走 useDict（PRD-005 FR-07），缺它会让普通用户只看到原始值，
 *  故按「字典是 UI 枚举元数据」的口径授予；用户写操作（user:create/update/delete）仍一律不授。 */
const USER_ROLE_CODES: string[] = [
  PERM.AUTH_LOGOUT,
  PERM.AUTH_ME,
  PERM.AUTH_CHANGE_PASSWORD,
  PERM.USER_READ,
  PERM.DICT_READ,
  // M10 E-13：消息中心。任务终态通知的收件人就是派发人，而不派发任务不意味着不需要「我的消息」，
  // 故按「人人可看的收件箱」口径授予普通用户（运维告警类消息仍靠权限码裁剪主题）。
  PERM.NOTIFICATION_READ,
  // M10 E-09：附件上传。带附件字段的表单是普通用户的日常操作（头像 / 附件 CRUD），
  // 按与 NOTIFICATION_READ 同口径授予；存储配额与类型白名单由 @fw/storage 服务端把关。
  PERM.FILE_CREATE,
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
      { name: '菜单管理', path: '/system/menus', component: 'system/menus', icon: 'menu', permissionCode: PERM.MENU_READ, sort: 4 },
      { name: '字典管理', path: '/system/dict', component: 'system/dict', icon: 'collection', permissionCode: PERM.DICT_READ, sort: 5 },
      // M7 队列管理页（views/system/queue）：前端动态路由由菜单树生成，缺此条则页面不可达（直输 URL 落 403）
      { name: '队列管理', path: '/system/queue', component: 'system/queue', icon: 'list', permissionCode: QUEUE_PERM_LIST, sort: 6 },
      // N-01 租户管理页（views/system/tenants）：列表 / 开租户 / 改套餐状态 / 停用 / 隔离级别迁移
      { name: '租户管理', path: '/system/tenants', component: 'system/tenants', icon: 'office-building', permissionCode: PERM.TENANT_READ, sort: 7 },
      // M9 参数配置页（views/system/configs）：键值列表 / 在线修改 / 变更历史（PRD-009 FR-07）
      { name: '参数配置', path: '/system/configs', component: 'system/configs', icon: 'tool', permissionCode: PERM.CONFIG_READ, sort: 8 },
      // P2 平台审计页（views/system/audit-logs/platform）：跨租户检索审计记录，仅平台维护账号可见。
      // 权限码刻意用 system:tenant:ignore（而不是再拆一个 menu 码）：菜单可见性必须与服务端
      // @IgnoreTenant 守卫的准入条件同源，否则会出现「菜单可见但接口 3002」或「有权限却无入口」。
      { name: '平台审计', path: '/system/audit-logs/platform', component: 'system/audit-logs/platform', icon: 'view', permissionCode: PERM.TENANT_IGNORE, sort: 9 },
    ],
  },
  // M13 SaaS 运营目录（PRD-013 §2.3）：★ 必须是**顶层目录**且 path 与子页同前缀（/saas）——
  // 前端 buildChildren 按「父 path 前缀 + 相对子路径」生成嵌套路由，若挂到 /system 目录下，
  // /saas/plans 会被拼成 /system/saas/plans 导致 404（v0.7.0 真机事故教训）。
  {
    name: 'SaaS 运营',
    path: '/saas',
    component: 'layout/blank',
    icon: 'box',
    permissionCode: null,
    sort: 3,
    children: [
      { name: '套餐管理', path: '/saas/plans', component: 'saas/plans', icon: 'box', permissionCode: PERM.OPS_SAAS_READ, sort: 1 },
      { name: '订阅管理', path: '/saas/subscriptions', component: 'saas/subscriptions', icon: 'ticket', permissionCode: PERM.OPS_SAAS_READ, sort: 2 },
      { name: '租户生命周期', path: '/saas/lifecycle', component: 'saas/lifecycle', icon: 'switch-button', permissionCode: PERM.OPS_SAAS_READ, sort: 3 },
      { name: '用量看板', path: '/saas/usage', component: 'saas/usage', icon: 'data-line', permissionCode: PERM.OPS_SAAS_READ, sort: 4 },
    ],
  },
  // 注意：历史种子在此挂了「订单中心 /order → 订单退款(order/refund)」，但 views/order/refund 视图
  // 与后端 /api/v1/orders 端点都不存在 —— 该菜单在真实部署里必然死链（路由被静默跳过、点击落 404），
  // 而演示用的订单列表页（apps/admin-web/src/views/demo/orders）与其 /orders 数据源只存在于前端 mock，
  // 属 dev/test 演示资产。故整支移除：真实部署的业务菜单示范由「DemoItem管理(/demo-items，带真实后端端点)」承担。
  // 若后续补真实订单模块，按 MENU_TREE 同格式追回即可（component 写 views 下相对路径）。
];

/**
 * 清场顺序：外键依赖倒序（租户级 SaaS/归档 → 关联表 → 主表 → 演示表 → 租户 → 字典）
 *
 * **租户级数据必须一并清掉**（docs/64 §5 #4 真机观察项，2026-10-21 修复）：
 * `tenants` 每次 reseed 都会被重建，若 `tenant_subscriptions` / `tenant_quotas` /
 * `tenant_quota_windows` / `usage_events` / `usage_rollups` / `tenant_lifecycle_logs` /
 * `audit_log_archives` 保留旧行，新租户就会**继承同 ID 旧租户的历史**——表现为
 * 「刚建的租户已有生效订阅」（`active_marker` 唯一键被占，开通直接 1003）、
 * 「新建租户用量已超限」、归档审计里出现不属于自己的行。ID 复用 + 残留是数据归属错误，
 * 不是展示问题，故一律清空。
 *
 * 故意**不清**目录类数据（`plans` / `plan_versions` / `plan_quotas` / `quota_definitions`）：
 * 它们是运营配置而非租户数据，不随租户 ID 复用产生错误归属；保留可让 reseed 后
 * 套餐页/配额字典仍有可操作样本（真实环境若要重置目录，走单独的目录维护流程）。
 */
async function truncate(): Promise<void> {
  // —— 租户级 SaaS 数据：必须先于 tenants 清（否则 ID 复用即产生错误归属）——
  // 订阅（含 active_marker 唯一键）、配额覆盖/快照、窗口用量、事件明细、汇总、生命周期日志
  await prisma.tenantSubscription.deleteMany();
  await prisma.tenantQuota.deleteMany();
  await prisma.tenantQuotaWindow.deleteMany();
  await prisma.usageEvent.deleteMany();
  await prisma.usageRollup.deleteMany();
  await prisma.tenantLifecycleLog.deleteMany();
  // 归档审计（冷数据）：同样带 tenant_id，reseed 后不复用旧租户 ID 的历史
  await prisma.auditLogArchive.deleteMany();

  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  // M10 E-13：站内信（收件人 ID 逻辑外键指向 users，先于主表清）
  await prisma.notification.deleteMany();
  // M10 E-09：附件元数据（owner_id 逻辑外键指向 users，先于主表清）
  await prisma.uploadFile.deleteMany();
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
  await prisma.tenant.deleteMany();
}

/** 字典种子：编码 / 名称 / 项（value 为程序值，label 为展示值，color 供标签取色） */
interface DictSeed {
  code: string;
  name: string;
  remark?: string;
  items: Array<{ label: string; value: string; color?: string }>;
}

/**
 * 字典基线（PRD-005 FR-07：页面不硬编码枚举）
 * 编码与前端实际消费点一一对应：
 *   user_status  —— 用户管理页状态列 / 表单（views/system/users/index.vue）
 *   data_scope   —— 角色管理页数据范围列 / 表单（views/system/roles/index.vue，四档与 roles.data_scope 同源）
 *   audit_action —— 审计日志页动作筛选列（views/system/audit-logs/index.vue）
 *   audit_module —— 审计日志页模块筛选列（E-07：原硬编码选项过期且缺 tenant，改字典消费）
 *   order_channel—— 订单演示页渠道筛选（views/demo/orders/index.vue）
 * 缺任一项，对应页面首次渲染即 404（GET /api/v1/dict/:code）。
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
      { label: '导出', value: 'export', color: 'info' },
      { label: '授权', value: 'grant', color: 'primary' },
      // M15：安全事件（replay / 越权拒绝）在记录层早已使用 action=security，字典此前缺项
      { label: '安全事件', value: 'security', color: 'danger' },
    ],
  },
  {
    code: 'audit_module',
    name: '审计模块',
    remark: '审计日志 module 字段取值（与各控制器写入值同源，E-07）',
    items: [
      { label: '认证', value: 'auth', color: 'primary' },
      { label: '用户', value: 'user', color: 'success' },
      { label: '角色', value: 'role', color: 'warning' },
      { label: '租户', value: 'tenant', color: 'info' },
      { label: '队列', value: 'queue', color: 'info' },
      { label: '配置', value: 'config', color: 'danger' },
      // M15：M13/M14 的 SaaS 审计全部 module=saas，字典此前缺项导致筛不到
      { label: 'SaaS 运营', value: 'saas', color: 'success' },
    ],
  },
  {
    code: 'order_channel',
    name: '订单渠道',
    remark: '演示订单来源渠道',
    items: [
      { label: '小程序', value: 'miniapp', color: 'primary' },
      { label: 'APP', value: 'app', color: 'success' },
      { label: '网页', value: 'web', color: 'info' },
      { label: '线下', value: 'offline', color: 'warning' },
    ],
  },
  {
    code: 'tenant_isolation',
    name: '租户隔离级别',
    remark: 'N-01 租户管理页：shared=共享库+tenant_id / dedicated=独立库（按租户路由数据源）',
    items: [
      { label: '共享库', value: 'shared', color: 'primary' },
      { label: '独立库', value: 'dedicated', color: 'warning' },
    ],
  },
  {
    code: 'tenant_status',
    name: '租户状态',
    remark: 'N-01 租户管理页：ADR-0029 §2.4 五态如实展示（0 存量停用读作 frozen / 1 active / 2 grace / 3 frozen / 4 terminated / 5 pending）；停用租户在租户解析上 fail-closed（4001）',
    items: [
      { label: '待开通', value: '5', color: 'info' },
      { label: '启用', value: '1', color: 'success' },
      { label: '宽限期', value: '2', color: 'warning' },
      { label: '冻结', value: '3', color: 'danger' },
      { label: '停用（存量）', value: '0', color: 'info' },
      { label: '已终止', value: '4', color: 'info' },
    ],
  },
];

/** 写入字典分类与字典项 */
async function seedDicts(): Promise<void> {
  let sort = 0;
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
    sort += 1;
  }
}

/**
 * 写入组织架构基线（M8 T-M8-04，PRD-008 FR-05，tenant_id=0 即 legacy 租户）：
 * 部门树（parent_id='0' 为顶级）：
 *   总部(hq)
 *   ├─ 研发部(rd)         ← bob 负责人（org_below：可见 rd + rd-fe + rd-be）
 *   │  ├─ 前端组(rd-fe)   ← alice / dave / erin
 *   │  └─ 后端组(rd-be)   ← frank
 *   └─ 市场部(mkt)        ← grace（org_below 范围外，用于越权断言）
 * 用户-部门分配见 seedUserDepartments。
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

/**
 * 写入租户基线（M8，PRD-008 FR-01/FR-02）：
 * - legacy（id '0'）：存量单租户数据的归属租户，种子账号默认 tenantId=0 全部落在此租户；
 * - acme（id '1'）：演示「子域名解析」与跨租户越权用例的第二个租户；
 * - off（id '2'）：停用租户，验证 fail-closed（403）；
 * - dedicated（id '3'）：独立库租户（T-M8-02），db_url_enc 存 AES-256-GCM 密文，
 *   连接串由 SEED_DEDICATED_DB_URL 提供；sqlite 部署下默认指向 prisma/tenant-dedicated.db，
 *   其他驱动下留 NULL（见文件顶部 DEDICATED_DB_URL 说明）。
 */
async function seedTenants(): Promise<void> {
  const rows = [
    { id: '0', code: 'legacy', name: '存量单租户', isolation: 'shared', status: 1 },
    { id: '1', code: 'acme', name: 'ACME 公司', isolation: 'shared', status: 1 },
    { id: '2', code: 'off', name: '已停用租户', isolation: 'shared', status: 0 },
    {
      id: '3',
      code: 'dedicated',
      name: '独立库租户',
      isolation: 'dedicated',
      // 连接串加密存储（T-M8-02）；未提供时留 NULL（非 sqlite 部署），见文件顶部说明
      dbUrlEnc: DEDICATED_DB_URL ? encryptDbUrl(DEDICATED_DB_URL) : null,
      status: 1,
    },
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

  // 3) 角色（dataScope：admin=all，user=self；M8 T-M8-04 增 org_below / org / self 三档示范角色）
  const adminRole = await prisma.role.create({
    data: { code: ROLE.ADMIN, name: '超级管理员', remark: '内置角色，拥有全部权限', isSystem: 1, dataScope: 'all', sort: 1 },
  });
  const userRole = await prisma.role.create({
    data: { code: ROLE.USER, name: '普通用户', remark: '内置角色，仅自身相关', isSystem: 1, dataScope: 'self', sort: 2 },
  });
  // M8 T-M8-04：数据权限四档验证角色（均持 user:read + user:update，差异只在 dataScope）
  const deptLeaderRole = await prisma.role.create({
    data: { code: 'dept_leader', name: '部门负责人', remark: 'M8 示范：本部门及下级数据（org_below，含审计查询）', isSystem: 0, dataScope: 'org_below', sort: 3 },
  });
  const deptMemberRole = await prisma.role.create({
    data: { code: 'dept_member', name: '部门成员', remark: 'M8 示范：本部门数据（org）', isSystem: 0, dataScope: 'org', sort: 4 },
  });
  const selfUpdaterRole = await prisma.role.create({
    data: { code: 'self_updater', name: '本人数据管理员', remark: 'M8 示范：仅本人数据（self，持 user:update 供详情越权验证）', isSystem: 0, dataScope: 'self', sort: 5 },
  });
  // M15 验收示范：租户内审计只读角色（dataScope=all，但**不**含 system:tenant:ignore）——
  // 普通租户管理员能看本租户全部审计，却无法跨租户；与 admin（平台维护）形成 A/B 对照账号。
  const tenantAuditorRole = await prisma.role.create({
    data: { code: 'tenant_auditor', name: '租户审计员', remark: 'M15 验收：本租户审计只读（dataScope=all，无跨租户维护）', isSystem: 0, dataScope: 'all', sort: 6 },
  });

  // 4) 授权：admin 全量；user 最小集；M8 三示范角色持 user:read + user:update
  //    （dept_leader 另持 audit:read，供 TC-TNT-004 验证 org_below 档审计收敛）
  for (const permissionId of permIdByCode.values()) {
    await prisma.rolePermission.create({ data: { roleId: adminRole.id, permissionId } });
  }
  for (const code of USER_ROLE_CODES) {
    await prisma.rolePermission.create({ data: { roleId: userRole.id, permissionId: permIdByCode.get(code) as string } });
  }
  const scopeDemoGrants: Array<{ roleId: string; codes: string[] }> = [
    { roleId: deptLeaderRole.id, codes: [PERM.USER_READ, PERM.USER_UPDATE, PERM.AUDIT_READ, PERM.NOTIFICATION_READ] },
    { roleId: deptMemberRole.id, codes: [PERM.USER_READ, PERM.USER_UPDATE, PERM.NOTIFICATION_READ] },
    { roleId: selfUpdaterRole.id, codes: [PERM.USER_READ, PERM.USER_UPDATE, PERM.NOTIFICATION_READ] },
    // M15：租户审计员只读审计（列表/详情/导出），刻意不授予任何写权限与跨租户维护码
    { roleId: tenantAuditorRole.id, codes: [PERM.AUTH_ME, PERM.AUTH_LOGOUT, PERM.AUDIT_READ, PERM.AUDIT_EXPORT] },
  ];
  for (const grant of scopeDemoGrants) {
    for (const code of grant.codes) {
      await prisma.rolePermission.create({ data: { roleId: grant.roleId, permissionId: permIdByCode.get(code) as string } });
    }
  }

  // 5) 菜单
  const menuCounter = { count: 0 };
  await seedMenus('0', MENU_TREE, menuCounter);

  // 5.5) 字典基线（PRD-005 FR-07：页面不硬编码枚举；缺项即对应页面 GET /dict/:code 404）
  await seedDicts();

  // 6) M6 生成器产物：权限点 + 菜单（幂等 upsert；truncate 之后执行，admin 显式授权后后台角色配置页可见）
  // <fw:gen:seed-calls>
  await seedDemoItemPermissions();
  // </fw:gen:seed-calls>
  for (const code of GENERATED_PERMISSION_CODES) {
    const permission = await prisma.permission.findUnique({ where: { code } });
    if (permission) {
      await prisma.rolePermission.create({ data: { roleId: adminRole.id, permissionId: permission.id } });
    }
  }

  // 6.5) M8 T-M8-04：组织架构（部门树；user_department 在第 9 步账号就绪后写入）
  const orgDeptIds = await seedDepartments();

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

  /** M8 T-M8-04 组织架构示范账号（tenant_id=0 即 legacy 租户） */
  const orgAccounts = [
    { username: 'bob', password: 'Bob@123456', nickname: 'Bob（研发部负责人）', email: 'bob@example.com', role: 'dept_leader', dept: 'rd' },
    { username: 'carol', password: 'Carol@123456', nickname: 'Carol（研发部）', email: 'carol@example.com', role: 'dept_member', dept: 'rd' },
    { username: 'dave', password: 'Dave@123456', nickname: 'Dave（前端组）', email: 'dave@example.com', role: 'dept_member', dept: 'rd-fe' },
    { username: 'erin', password: 'Erin@123456', nickname: 'Erin（前端组）', email: 'erin@example.com', role: 'user', dept: 'rd-fe' },
    { username: 'frank', password: 'Frank@123456', nickname: 'Frank（后端组）', email: 'frank@example.com', role: 'user', dept: 'rd-be' },
    { username: 'grace', password: 'Grace@123456', nickname: 'Grace（市场部）', email: 'grace@example.com', role: 'user', dept: 'mkt' },
    { username: 'selfscope', password: 'Self@123456', nickname: 'SelfScope（本人范围）', email: 'selfscope@example.com', role: 'self_updater', dept: null },
  ];
  const orgUserIds = new Map<string, string>();
  for (const account of orgAccounts) {
    const created = await prisma.user.create({
      data: {
        username: account.username,
        passwordHash: await passwords.hash(account.password),
        nickname: account.nickname,
        email: account.email,
        status: 1,
      },
    });
    orgUserIds.set(account.username, created.id);
  }

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
  // M15 验收：acme 租户审计员（tenantId=1，dataScope=all，仅本租户审计只读）——
  // 与 admin（legacy + 平台维护码）配对，用于「普通租户管理员 / 平台维护管理员」双账号真机与冒烟对照。
  const acmeAuditorPassword = 'AcmeAudit@123456';
  const acmeAuditor = await prisma.user.create({
    data: {
      username: 'acmeauditor',
      tenantId: 1n,
      passwordHash: await passwords.hash(acmeAuditorPassword),
      nickname: 'ACME 审计员',
      email: 'acmeauditor@acme.example.com',
      status: 1,
    },
  });
  // M8 T-M8-02：dedicated 租户管理员（tenantId=3，账号仍在共享库，业务数据走独立库）
  const dedicatedPassword = 'Dedicated@123456';
  await prisma.user.create({
    data: {
      username: 'dedicatedadmin',
      tenantId: 3n,
      passwordHash: await passwords.hash(dedicatedPassword),
      nickname: '独立库租户管理员',
      email: 'dedicatedadmin@dedicated.example.com',
      status: 1,
    },
  });

  // 8) 用户-角色（acmeadmin 与 alice 同权，角色归属第 5 步的 userRole）
  const roleByCode = new Map(
    [adminRole, userRole, deptLeaderRole, deptMemberRole, selfUpdaterRole, tenantAuditorRole].map((role) => [role.code, role.id]),
  );
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
  await prisma.userRole.create({ data: { userId: alice.id, roleId: userRole.id } });
  for (const account of orgAccounts) {
    await prisma.userRole.create({ data: { userId: orgUserIds.get(account.username) as string, roleId: roleByCode.get(account.role) as string } });
  }
  const acmeUser = await prisma.user.findUnique({ where: { username: 'acmeadmin' } });
  if (acmeUser) await prisma.userRole.create({ data: { userId: acmeUser.id, roleId: userRole.id } });
  // M15：acme 审计员持 tenant_auditor（audit:read + audit:export，无 system:tenant:ignore）
  await prisma.userRole.create({ data: { userId: acmeAuditor.id, roleId: tenantAuditorRole.id } });

  // 9) M8 T-M8-04：用户-部门分配（is_primary=1 标主部门；selfscope 无部门，用于「无归属收敛 self」验证）
  const deptIdByCode = orgDeptIds;
  const deptOfUser: Array<{ username: string; dept: string }> = [
    { username: 'alice', dept: 'rd-fe' },
    ...orgAccounts.filter((a) => a.dept).map((a) => ({ username: a.username, dept: a.dept as string })),
  ];
  for (const item of deptOfUser) {
    await prisma.userDepartment.create({
      data: { userId: item.username === 'alice' ? alice.id : (orgUserIds.get(item.username) as string), departmentId: deptIdByCode.get(item.dept) as string, isPrimary: 1 },
    });
  }
  // 研发部负责人回填（bob）
  await prisma.department.update({
    where: { id: deptIdByCode.get('rd') as string },
    data: { leaderId: orgUserIds.get('bob') as string },
  });

  console.log(
    [
      '[seed] 完成：',
      `演示条目 ${SEED_ITEMS.length} 条`,
      `权限点 ${permIdByCode.size + GENERATED_PERMISSION_CODES.length} 个（框架/业务 ${permIdByCode.size} + 生成器 ${GENERATED_PERMISSION_CODES.length}）`,
      `角色 6 个（${ROLE.ADMIN}=all / ${ROLE.USER}=self / dept_leader=org_below / dept_member=org / self_updater=self / tenant_auditor=all·审计只读）`,
      `菜单 ${menuCounter.count} 项`,
      `部门 ${orgDeptIds.size} 个（总部 → 研发部 → 前端组/后端组；总部 → 市场部）`,
      `账号 11 个（admin / ${adminPassword}，alice / ${userPassword}）+ orgAccounts 7 个（bob/carol/dave/erin/frank/grace/selfscope）+ acmeadmin / ${acmePassword}（tenantId=1）+ acmeauditor / ${acmeAuditorPassword}（tenantId=1 审计只读）+ dedicatedadmin / ${dedicatedPassword}（tenantId=3 独立库）`,
      `租户 4 个（legacy=0 / acme=1 / off=2 停用 / dedicated=3 独立库）`,
    ].join(' '),
  );
}

main()
  .catch((error: unknown) => {
    console.error('[seed] 失败:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

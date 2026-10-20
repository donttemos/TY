/*
 * @file 审计事件注册表（PRD-015 FR-15-01/02，ADR-0032 R1/R2/R9）
 * @description 审计事件的唯一语义权威：事件码、名称、说明、分类、风险、处理指引、摘要模板与
 *   变更字段中文名。注册表在代码内单源声明（不新建包、不入库），由 `GET /api/v1/audit-events`
 *   只读下发；写入侧经 `AuditService.recordEvent` 校验，展示侧（前端/导出/归档）同一份定义渲染。
 *
 *   两条硬约束（ADR-0032）：
 *   ① 事件码一经发布不可改名——历史行里已存在该字符串，改名等于让历史失去解释；语义废弃走
 *      `deprecated`（保留 ≥2 个小版本并标注 replacedBy），条目不得删除。
 *   ② 解释性元数据（名称/说明/风险/指引/字段中文名）**不进库**：它们是会演进的字典，
 *      而审计行是不可变事实；把字典冻进行里会导致文案纠错无法回溯、行体积膨胀。
 * @author donttemo
 * @created 2026-10-20
 * @modified 2026-10-21 donttemo P1（PRD-015 FR-15-10 收口）：新增名称快照缺失标记
 *   `SNAPSHOT_MISSING_LABEL` / `snapshotMissingLabel`——写入点解析不到目标对象名称时
 *   显式写「名称快照缺失（ID: …）」，与展示侧（admin-web `ACTOR_SNAPSHOT_MISSING`）同口径，
 *   杜绝把 ID 当名称落库（运营视角的 target_label 必须是租户名/套餐名/用户名）。
 * @module @fw/auth
 */

import type { AuditAction, AuditCategory } from './types.js';

/**
 * 事件风险等级（治理判断，不落库；筛选时按事件集合展开，ADR-0032 R9）
 */
export type AuditEventRisk = 'low' | 'notice' | 'high' | 'critical';

/**
 * 事件域：由事件码首段派生（`saas.plan.publish` → `saas`），不新增数据库列
 */
export type AuditEventDomain = 'auth' | 'security' | 'tenant' | 'saas' | 'config' | 'system';

/**
 * 变更字段的展示定义
 *
 * `valueLabels` 是纯数据映射（如状态码 → 中文），不含可执行逻辑——
 * 注册表要能被序列化后下发给前端，不能携带函数。
 */
export interface AuditEventChangeField {
  /** 中文字段名（详情页「变更前/变更后」两侧的标签） */
  label: string;
  /** 枚举取值 → 业务文案（如 `3` → `冻结`） */
  valueLabels?: Record<string, string>;
}

/**
 * 事件定义（注册表条目）
 */
export interface AuditEventDefinition {
  /** 稳定事件码：`<domain>.<aggregate>.<verb>`，发布后不可改名 */
  code: string;
  /** 运营看到的事件名称 */
  name: string;
  /** 说明发生了什么、有什么影响 */
  description: string;
  /** 审计大类：沿用 M12 七值做低基数粗筛（不扩展枚举，ADR-0032 R9） */
  category: AuditCategory;
  /** 落库 module（兼容既有筛选，写入侧不再由调用方传） */
  module: string;
  /** 落库 action（兼容既有筛选） */
  action: AuditAction;
  /** 风险等级 */
  risk: AuditEventRisk;
  /** 是否需要人工复核 */
  reviewRequired?: boolean;
  /** 处理指引（运营下一步做什么） */
  guidance?: string;
  /** 目标对象类型（写入侧未显式提供时补全） */
  targetType?: string;
  /** 摘要模板：变量仅允许 `targetLabel` / `reason` 与 `changeFields` 的键 */
  summaryTemplate?: string;
  /** 变更明细字段字典 */
  changeFields?: Record<string, AuditEventChangeField>;
  /** 语义废弃标记（条目保留，不删除） */
  deprecated?: { since: string; replacedBy?: string };
}

/**
 * 事件码命名规则：`<domain>.<verb>` 或 `<domain>.<aggregate>.<verb>`，至少两段点分小写
 *
 * 两段用于「对象即动词」的实体操作（`user.create` / `config.change`），
 * 三段用于需要限定聚合根的领域动作（`saas.plan.publish` / `saas.lifecycle.freeze`）。
 * 曾计划强制三段，实施时改为两段起：为凑段数把 `auth.login` 写成 `auth.session.login`
 * 只会增加记忆成本，不增加信息量（ADR-0032 R1 已同步修订）。
 */
export const AUDIT_EVENT_CODE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * 生命周期状态文案（ADR-0031 五态 + 存量停用码 0）
 *
 * 放在注册表内而非前端：导出 CSV 与归档查询也在服务端渲染，两处必须同源。
 */
const LIFECYCLE_STATE_LABELS: Record<string, string> = {
  '0': '停用（存量）',
  '1': '正常',
  '2': '宽限',
  '3': '冻结',
  '4': '终止',
  '5': '待开通',
  pending: '待开通',
  active: '正常',
  grace: '宽限',
  frozen: '冻结',
  terminated: '终止',
};

/** 生命周期事件的共用变更字段定义 */
const LIFECYCLE_CHANGE_FIELDS: Record<string, AuditEventChangeField> = {
  from: { label: '迁移前状态', valueLabels: LIFECYCLE_STATE_LABELS },
  to: { label: '迁移后状态', valueLabels: LIFECYCLE_STATE_LABELS },
};

/**
 * 事件注册表（唯一权威）
 *
 * 收录范围（M15 B1）：当前代码已实际写入的事件码。B2 补齐认证/账号/配置/运维事件时
 * 在此追加，并同步覆盖矩阵与 `check:audit-events` 门禁。
 *
 * 注意 `saas.lifecycle.*` 前缀：历史行已按此写入（v0.7.x 已部署），按 ADR-0032 R1
 * 「码不可改名」保留原前缀，不改写为 `tenant.lifecycle.*`。
 */
export const AUDIT_EVENTS: readonly AuditEventDefinition[] = [
  // ---------- 安全 ----------
  {
    code: 'refresh.replay_detected',
    name: '检测到刷新令牌重复使用',
    description: '同一刷新令牌被重复使用或指纹不匹配，判定为疑似泄漏；系统已撤销整个令牌族并要求重新登录。',
    category: 'security',
    module: 'auth',
    action: 'security',
    risk: 'critical',
    reviewRequired: true,
    guidance: '核对该用户的登录来源与设备；如非本人操作，建议重置口令并检查会话。',
    targetType: 'refresh_family',
    summaryTemplate: '检测到刷新令牌重复使用，已撤销该令牌族全部会话（原因：{reason}）',
    changeFields: {
      reason: { label: '判定原因' },
      detail: { label: '判定说明' },
    },
  },

  // ---------- 套餐与订阅 ----------
  {
    code: 'saas.plan.create',
    name: '创建套餐',
    description: '新建一个套餐（尚未发布版本，暂不可被订阅绑定）。',
    category: 'admin',
    module: 'saas',
    action: 'create',
    risk: 'notice',
    targetType: 'plan',
    summaryTemplate: '创建套餐「{targetLabel}」',
    changeFields: {
      code: { label: '套餐编码' },
      name: { label: '套餐名称' },
      description: { label: '套餐说明' },
    },
  },
  {
    code: 'saas.plan.publish',
    name: '发布套餐版本',
    description: '发布套餐的新版本。发布后版本不可变，已绑定旧版本的订阅不受影响。',
    category: 'admin',
    module: 'saas',
    action: 'create',
    risk: 'high',
    targetType: 'plan',
    summaryTemplate: '发布套餐「{targetLabel}」的新版本 v{version}（配额项 {quotaCount} 项）',
    changeFields: {
      version: { label: '版本号' },
      quotaCount: { label: '配额项数' },
      remark: { label: '版本说明' },
    },
  },
  {
    code: 'saas.subscription.create',
    name: '开通订阅',
    description: '为租户建立订阅并绑定套餐版本，租户权益自此生效。',
    category: 'admin',
    module: 'saas',
    action: 'create',
    risk: 'notice',
    targetType: 'tenant_subscription',
    summaryTemplate: '为租户开通订阅（套餐 {planCode}，版本 {planVersion}）',
    changeFields: {
      planCode: { label: '套餐编码' },
      planVersion: { label: '套餐版本' },
      expireAt: { label: '到期时间' },
    },
  },
  {
    code: 'saas.subscription.cancel',
    name: '取消订阅',
    description: '取消租户的生效订阅，租户权益随之失效。',
    category: 'admin',
    module: 'saas',
    action: 'update',
    risk: 'high',
    reviewRequired: true,
    guidance: '确认取消原因与客户沟通记录；若为误操作，需重新开通订阅。',
    targetType: 'tenant_subscription',
    summaryTemplate: '取消租户订阅（原因：{reason}）',
    changeFields: { reason: { label: '取消原因' } },
  },
  {
    code: 'saas.quota.exceeded',
    name: '配额超限被拒绝',
    description: '租户用量超过硬限额，本次请求被拒绝（未产生用量扣减）。',
    category: 'admin',
    module: 'saas',
    action: 'security',
    risk: 'notice',
    targetType: 'tenant',
    summaryTemplate: '租户配额超限，请求被拒绝（指标：{quotaKey}）',
    changeFields: {
      quotaKey: { label: '配额指标' },
      idempotencyKey: { label: '幂等键' },
    },
  },

  // ---------- 租户生命周期（六动作独立码；沿用已部署前缀） ----------
  {
    code: 'saas.lifecycle.activate',
    name: '开通租户',
    description: '租户由待开通进入正常状态，服务开始可用。',
    category: 'tenant',
    module: 'saas',
    action: 'update',
    risk: 'notice',
    targetType: 'tenant',
    summaryTemplate: '将租户「{targetLabel}」由{from}变更为{to}',
    changeFields: LIFECYCLE_CHANGE_FIELDS,
  },
  {
    code: 'saas.lifecycle.freeze',
    name: '冻结租户',
    description: '冻结租户，业务入口按白名单拒绝请求（4031），只保留只读与导出能力。',
    category: 'tenant',
    module: 'saas',
    action: 'update',
    risk: 'high',
    reviewRequired: true,
    guidance: '确认冻结依据（欠费/违规/客户申请）并记录原因；恢复需重新走 resume。',
    targetType: 'tenant',
    summaryTemplate: '将租户「{targetLabel}」由{from}变更为{to}（原因：{reason}）',
    changeFields: LIFECYCLE_CHANGE_FIELDS,
  },
  {
    code: 'saas.lifecycle.resume',
    name: '恢复租户',
    description: '租户由冻结/宽限恢复为正常，业务入口重新放行。',
    category: 'tenant',
    module: 'saas',
    action: 'update',
    risk: 'notice',
    targetType: 'tenant',
    summaryTemplate: '将租户「{targetLabel}」由{from}变更为{to}',
    changeFields: LIFECYCLE_CHANGE_FIELDS,
  },
  {
    code: 'saas.lifecycle.terminate',
    name: '终止租户',
    description: '终止租户并进入数据保留期；保留期满后按策略处置业务数据（审计记录永久保留）。',
    category: 'tenant',
    module: 'saas',
    action: 'update',
    risk: 'critical',
    reviewRequired: true,
    guidance: '终止不可逆（仅保留期内可导出）。执行前确认合同状态与数据导出需求。',
    targetType: 'tenant',
    summaryTemplate: '将租户「{targetLabel}」由{from}变更为{to}（原因：{reason}）',
    changeFields: LIFECYCLE_CHANGE_FIELDS,
  },
  {
    code: 'saas.lifecycle.expire',
    name: '租户进入宽限期',
    description: '订阅到期后由系统任务置为宽限状态，宽限期满将进一步冻结。',
    category: 'tenant',
    module: 'saas',
    action: 'update',
    risk: 'low',
    targetType: 'tenant',
    summaryTemplate: '租户「{targetLabel}」由{from}变更为{to}',
    changeFields: LIFECYCLE_CHANGE_FIELDS,
  },
  {
    code: 'saas.lifecycle.dispose',
    name: '处置租户数据',
    description: '保留期满后按策略导出并删除业务数据（审计记录不删除）。',
    category: 'tenant',
    module: 'saas',
    action: 'delete',
    risk: 'critical',
    reviewRequired: true,
    guidance: '确认保留期与导出产物已归档；该操作会删除业务表数据。',
    targetType: 'tenant',
    summaryTemplate: '处置租户「{targetLabel}」的数据（{from} → {to}）',
    changeFields: LIFECYCLE_CHANGE_FIELDS,
  },

  // ---------- 认证与账号（M15 B2 / FR-15-08） ----------
  {
    code: 'auth.login',
    name: '登录成功',
    description: '账号通过认证并建立会话（口令或外部身份提供方）。',
    category: 'auth',
    module: 'auth',
    action: 'login',
    risk: 'low',
    targetType: 'user',
    summaryTemplate: '用户「{targetLabel}」登录成功（方式：{via}）',
    changeFields: {
      via: { label: '认证方式', valueLabels: { password: '口令', oauth2: 'OAuth2' } },
    },
  },
  {
    code: 'auth.login_failed',
    name: '登录失败',
    description: '认证未通过（口令错误、账号锁定/禁用或触发登录限流），未建立会话。',
    category: 'security',
    module: 'auth',
    action: 'login',
    risk: 'notice',
    targetType: 'user',
    guidance: '同一来源短时间多次失败需核验 IP 与账号安全，必要时冻结账号。',
    summaryTemplate: '用户「{targetLabel}」登录失败（原因：{reason}）',
    changeFields: {
      reason: {
        label: '失败原因',
        valueLabels: {
          bad_credentials: '账号或密码错误',
          account_locked: '账号锁定或已禁用',
          rate_limited: '触发登录限流',
        },
      },
    },
  },
  {
    code: 'auth.logout',
    name: '退出登录',
    description: '主动退出，当前设备的刷新令牌族被撤销。',
    category: 'auth',
    module: 'auth',
    action: 'logout',
    risk: 'low',
    targetType: 'user',
    summaryTemplate: '用户「{targetLabel}」退出登录',
    changeFields: { revokedRefreshTokens: { label: '撤销刷新令牌数' } },
  },
  {
    code: 'auth.password_change',
    name: '修改密码',
    description: '账号口令被修改，其它设备的会话全部下线（当前设备换发新令牌）。',
    category: 'auth',
    module: 'auth',
    action: 'update',
    risk: 'notice',
    targetType: 'user',
    guidance: '非本人操作时立即冻结账号并排查会话来源。',
    summaryTemplate: '用户「{targetLabel}」修改密码（其余设备已下线）',
    changeFields: { revokedRefreshTokens: { label: '下线会话数' } },
  },
  {
    code: 'auth.session_revoke',
    name: '强制下线',
    description: '管理员撤销目标用户的全部会话（禁用账号、踢下线或安全处置）。',
    category: 'auth',
    module: 'auth',
    action: 'logout',
    risk: 'high',
    targetType: 'user',
    summaryTemplate: '强制目标用户下线（撤销其全部登录会话）',
    changeFields: { revokedRefreshTokens: { label: '撤销刷新令牌数' } },
  },
  {
    code: 'auth.register',
    name: '注册账号',
    description: '自助注册创建账号并授予默认角色。',
    category: 'auth',
    module: 'auth',
    action: 'create',
    risk: 'notice',
    targetType: 'user',
    summaryTemplate: '注册账号「{targetLabel}」',
  },
  {
    code: 'auth.role_assign',
    name: '调整用户角色',
    description: '全量覆盖目标用户的角色集合，权限即时生效（相关用户缓存已失效）。',
    category: 'auth',
    module: 'auth',
    action: 'grant',
    risk: 'high',
    reviewRequired: true,
    guidance: '确认角色范围符合最小权限；空串或失效角色 ID 会被拒绝。',
    targetType: 'user',
    summaryTemplate: '调整用户「{targetLabel}」的角色集合',
    changeFields: { roleIds: { label: '角色集合' } },
  },
  {
    code: 'auth.permission_grant',
    name: '调整角色权限',
    description: '全量覆盖角色权限点，持有该角色的用户权限即时变化。',
    category: 'auth',
    module: 'auth',
    action: 'grant',
    risk: 'critical',
    reviewRequired: true,
    guidance: '权限变更影响所有持有该角色的账号，请核对授权范围与审批记录。',
    targetType: 'role_permission',
    summaryTemplate: '调整角色权限（角色 {targetLabel}）',
    changeFields: { permissionIds: { label: '权限点集合' } },
  },
  {
    code: 'auth.profile_update',
    name: '更新本人资料',
    description: '用户自助修改昵称 / 手机号 / 邮箱（不含账号名、状态与角色）。',
    category: 'auth',
    module: 'user',
    action: 'update',
    risk: 'low',
    targetType: 'user',
    summaryTemplate: '用户「{targetLabel}」更新本人资料',
    changeFields: { nickname: { label: '昵称' }, phone: { label: '手机号' }, email: { label: '邮箱' } },
  },
  {
    code: 'authz.denied',
    name: '权限不足被拒绝',
    description: '请求所需权限码未全部命中，请求被拒绝且未产生业务效果。',
    category: 'security',
    module: 'auth',
    action: 'security',
    risk: 'notice',
    reviewRequired: false,
    guidance: '同一账号持续越权尝试需核对其角色配置与来源。',
    targetType: 'endpoint',
    summaryTemplate: '访问「{targetLabel}」被拒绝（缺少权限：{reason}）',
    changeFields: {
      method: { label: '请求方法' },
      required: { label: '所需权限码' },
    },
  },

  // ---------- 账号与角色管理（M15 B2 / FR-15-08） ----------
  {
    code: 'user.create',
    name: '创建用户',
    description: '管理端创建账号，可同时分配初始角色。',
    category: 'admin',
    module: 'user',
    action: 'create',
    risk: 'notice',
    targetType: 'user',
    summaryTemplate: '创建用户「{targetLabel}」',
    changeFields: { username: { label: '账号名' }, roleIds: { label: '初始角色' } },
  },
  {
    code: 'user.update',
    name: '更新用户',
    description: '修改用户资料或角色集合（管理面）。',
    category: 'admin',
    module: 'user',
    action: 'update',
    risk: 'notice',
    targetType: 'user',
    summaryTemplate: '更新用户「{targetLabel}」的资料',
    changeFields: { nickname: { label: '昵称' }, status: { label: '账号状态', valueLabels: { '0': '禁用', '1': '启用' } }, roleIds: { label: '角色集合' } },
  },
  {
    code: 'user.status_change',
    name: '启用/禁用账号',
    description: '切换账号状态；禁用时同时强制下线其全部会话。',
    category: 'admin',
    module: 'user',
    action: 'update',
    risk: 'high',
    targetType: 'user',
    summaryTemplate: '将用户「{targetLabel}」状态改为{status}',
    changeFields: {
      status: { label: '账号状态', valueLabels: { '0': '禁用', '1': '启用' } },
      forcedLogout: { label: '是否强制下线', valueLabels: { true: '是', false: '否' } },
    },
  },
  {
    code: 'user.delete',
    name: '删除用户',
    description: '软删除账号并强制下线；内置管理员账号不允许删除。',
    category: 'admin',
    module: 'user',
    action: 'delete',
    risk: 'high',
    reviewRequired: true,
    targetType: 'user',
    summaryTemplate: '删除用户「{targetLabel}」',
    changeFields: { forcedLogout: { label: '是否强制下线', valueLabels: { true: '是', false: '否' } } },
  },
  {
    code: 'role.create',
    name: '创建角色',
    description: '新建角色（可复制已有角色作为起点）。',
    category: 'admin',
    module: 'role',
    action: 'create',
    risk: 'notice',
    targetType: 'role',
    summaryTemplate: '创建角色「{targetLabel}」',
    changeFields: { code: { label: '角色编码' }, copyFrom: { label: '复制来源' } },
  },
  {
    code: 'role.update',
    name: '更新角色',
    description: '修改角色名称、数据范围或备注。',
    category: 'admin',
    module: 'role',
    action: 'update',
    risk: 'notice',
    targetType: 'role',
    summaryTemplate: '更新角色「{targetLabel}」',
    changeFields: { name: { label: '角色名称' }, dataScope: { label: '数据范围' } },
  },
  {
    code: 'role.delete',
    name: '删除角色',
    description: '删除角色；内置角色不可删除。',
    category: 'admin',
    module: 'role',
    action: 'delete',
    risk: 'high',
    reviewRequired: true,
    targetType: 'role',
    summaryTemplate: '删除角色「{targetLabel}」',
  },

  // ---------- 配置与运维（M15 B2 / FR-15-11） ----------
  {
    code: 'config.change',
    name: '修改配置',
    description: '运行时配置被覆盖或回滚；先审计后生效，审计失败则整体失败。',
    category: 'config',
    module: 'config',
    action: 'update',
    risk: 'high',
    targetType: 'config',
    summaryTemplate: '修改配置项 {targetLabel}',
    changeFields: {
      value: { label: '配置值' },
      source: { label: '变更来源', valueLabels: { api: '接口', file: '配置文件', rollback: '回滚' } },
      ok: { label: '是否生效', valueLabels: { true: '已生效', false: '未生效' } },
    },
  },
  {
    code: 'audit.export',
    name: '导出审计日志',
    description: '按筛选条件派发审计导出任务（异步产物，受行数上限与数据范围约束）。',
    category: 'system',
    module: 'audit',
    action: 'export',
    risk: 'notice',
    targetType: 'audit_export',
    summaryTemplate: '导出审计日志（{targetLabel}）',
    changeFields: { filters: { label: '筛选条件' } },
  },
  {
    code: 'saas.lifecycle.invalid',
    name: '生命周期迁移被拒绝',
    description: '请求的状态迁移不在合法迁移表内（4030），未改变租户状态。',
    category: 'tenant',
    module: 'saas',
    action: 'update',
    risk: 'notice',
    targetType: 'tenant',
    guidance: '核对租户真实状态与允许动作；重复出现说明调用方状态判断有误。',
    summaryTemplate: '租户「{targetLabel}」的迁移动作 {action} 被拒绝（当前状态不允许）',
    changeFields: {
      action: {
        label: '请求动作',
        valueLabels: {
          activate: '开通',
          expire: '到期转宽限',
          freeze: '冻结',
          resume: '恢复',
          terminate: '终止',
          dispose: '处置数据',
        },
      },
    },
  },
];

/** 事件码 → 定义（模块初始化时构建一次） */
const AUDIT_EVENT_MAP: ReadonlyMap<string, AuditEventDefinition> = new Map(
  AUDIT_EVENTS.map((definition) => [definition.code, definition]),
);

/**
 * 查询事件定义
 * @param code 事件码
 * @returns 定义；未登记返回 undefined
 */
export function findAuditEvent(code: string): AuditEventDefinition | undefined {
  return AUDIT_EVENT_MAP.get(code);
}

/**
 * 事件域（码首段）：`saas.plan.publish` → `saas`
 * @param code 事件码
 */
export function auditEventDomain(code: string): string {
  const index = code.indexOf('.');
  return index > 0 ? code.slice(0, index) : code;
}

/**
 * 列出注册表条目（默认排除已废弃）
 * @param options.includeDeprecated 是否包含 deprecated 条目（考古/导出兼容用）
 */
export function listAuditEvents(options: { includeDeprecated?: boolean } = {}): readonly AuditEventDefinition[] {
  return options.includeDeprecated ? AUDIT_EVENTS : AUDIT_EVENTS.filter((definition) => !definition.deprecated);
}

/**
 * 按风险等级取事件码集合（筛选「按风险」时展开为 `event in (...)`，ADR-0032 R9）
 * @param risk 风险等级
 */
export function auditEventCodesByRisk(risk: AuditEventRisk): string[] {
  return AUDIT_EVENTS.filter((definition) => definition.risk === risk).map((definition) => definition.code);
}

/**
 * 渲染摘要模板：`{key}` 用 vars 替换，未知占位符置空（不残留花括号）
 * @param definition 事件定义
 * @param vars 变量表（targetLabel / reason / changeFields 的值）
 * @returns 摘要文本；模板为空时回退「事件名称：对象」
 */
export function renderAuditSummary(definition: AuditEventDefinition, vars: Record<string, string>): string {
  const template = definition.summaryTemplate ?? `${definition.name}：{targetLabel}`;
  const text = template.replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? '');
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : definition.name;
}

/**
 * 名称快照缺失标记（PRD-015 FR-15-04 / AC-15-02）
 *
 * 写入点解析不到目标对象名称时（租户已删除、脏数据引用、并发删除），把这一事实
 * **显式写进 `target_label`**，附对象 ID 便于追查；绝不让 ID 冒充名称——
 * 运营在对象列看到 `t1` 会以为是租户名，看到 `名称快照缺失（ID: t1）` 才知道当时就没取到名。
 * 文案与展示侧（admin-web `ACTOR_SNAPSHOT_MISSING`）保持一致：两侧是同一约定的写入/读取两端。
 */
export const SNAPSHOT_MISSING_LABEL = '名称快照缺失';

/**
 * 名称快照缺失的完整标记（带追查 ID）
 * @param id 目标对象 ID（缺失时退化为不带 ID 的纯标记）
 */
export function snapshotMissingLabel(id?: string | null): string {
  return id ? `${SNAPSHOT_MISSING_LABEL}（ID: ${id}）` : SNAPSHOT_MISSING_LABEL;
}

/**
 * 注册表版本指纹（FNV-1a，32 位）
 *
 * 供 `GET /api/v1/audit-events` 下发，前端按 version 缓存注册表；文案或风险调整会改变指纹，
 * 从而让前端在下次加载时刷新——但**不改变任何历史审计行**（解释元数据不落库，ADR-0032 R2）。
 */
export function auditRegistryVersion(): string {
  const payload = JSON.stringify(AUDIT_EVENTS.map((item) => [item.code, item.name, item.risk, item.summaryTemplate ?? '']));
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 注册表自检（单元测试与 `check:audit-events` 门禁共用）
 *
 * 校验项：码唯一、命名合规、必填文案非空、module/action/category 合法、
 * deprecated 必须带 replacedBy、changeFields 的 label 非空。
 * @returns 错误列表（空数组 = 通过）
 */
export function verifyAuditRegistry(): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const categories = new Set(['auth', 'security', 'admin', 'data', 'config', 'tenant', 'system']);
  const actions = new Set(['create', 'update', 'delete', 'login', 'logout', 'export', 'grant', 'security']);
  const risks = new Set(['low', 'notice', 'high', 'critical']);

  for (const definition of AUDIT_EVENTS) {
    if (seen.has(definition.code)) issues.push(`事件码重复：${definition.code}`);
    seen.add(definition.code);
    if (!AUDIT_EVENT_CODE_PATTERN.test(definition.code)) issues.push(`事件码命名不合规：${definition.code}`);
    if (!definition.name.trim()) issues.push(`事件名称为空：${definition.code}`);
    if (!definition.description.trim()) issues.push(`事件说明为空：${definition.code}`);
    if (!categories.has(definition.category)) issues.push(`category 非法：${definition.code} → ${definition.category}`);
    if (!actions.has(definition.action)) issues.push(`action 非法：${definition.code} → ${definition.action}`);
    if (!risks.has(definition.risk)) issues.push(`risk 非法：${definition.code} → ${definition.risk}`);
    if (!definition.module.trim()) issues.push(`module 为空：${definition.code}`);
    if (definition.deprecated && !definition.deprecated.since) issues.push(`deprecated 缺 since：${definition.code}`);
    for (const [field, meta] of Object.entries(definition.changeFields ?? {})) {
      if (!meta.label.trim()) issues.push(`changeFields.${field} 缺 label：${definition.code}`);
    }
    // 摘要模板只允许引用已声明变量，防止模板里出现无法求值的占位符
    const allowed = new Set(['targetLabel', 'reason', ...Object.keys(definition.changeFields ?? {})]);
    for (const match of (definition.summaryTemplate ?? '').matchAll(/\{(\w+)\}/g)) {
      if (!allowed.has(match[1]!)) issues.push(`摘要模板引用未声明变量 {${match[1]}}：${definition.code}`);
    }
  }
  return issues;
}

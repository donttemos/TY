/*
 * @file C-05 权限契约（类型即契约，冻结）
 * @description 并行工作线契约（docs/85-parallel-workstreams.md 表 C-05）：L2 实现、L4/L5 消费。
 *   本文件声明鉴权对外部可观测的**结构与语义**，不含实现：RequestUser 形状、权限码格式、
 *   菜单树 JSON、@Permissions 语义、守卫失败返回码。实现方（@fw/auth）签名必须与本契约一致；
 *   消费方（管理后台前端、代码生成器）照此写 mock 与类型，无需等待实现。
 *   冻结后修改需走契约变更（L0 独占维护），不得由消费线私自改签名。
 * @author donttemo
 * @created 2026-10-13
 * @module docs/contracts
 */

/** 主键：框架统一字符串主键（UUID），业务表不得使用自增数值作为对外主键 */
export type ID = string;

/** 认证策略名（由 AUTH_STRATEGY 或路由元数据选择） */
export type AuthStrategyName = 'jwt' | 'session' | 'oauth2' | 'apikey';

/** 数据权限范围四档（与数据字典 `roles.data_scope` 同源） */
export type DataScope = 'all' | 'org_below' | 'org' | 'self';

/** 权限点类型 */
export type PermissionType = 'menu' | 'button' | 'api';

/**
 * 权限码格式：`资源:操作`（小写、冒号分隔、段内连字符）
 * @example 'order:refund' | 'user:assign-role' | 'auth:change-password'
 */
export type PermissionCode = `${string}:${string}`;

/**
 * 守卫写入 `request.user` 的结构（审计与数据权限据此取操作人）
 * 消费方约定：`dataScope` 只可**收窄**不可放宽；`self` 场景一律以 `id` 作为归属人。
 */
export interface RequestUser {
  /** 主体 ID：登录用户为用户 ID；API Key / OAuth2 为 `apikey:<主体名>` */
  id: ID;
  /** 用户名（服务账号为主体名） */
  username: string;
  /** 角色编码列表（服务账号为空） */
  roles: string[];
  /** 权限码列表 */
  permissions: PermissionCode[];
  /** 生效数据范围：多角色取最宽 */
  dataScope: DataScope;
  /** 身份来源策略 */
  via: AuthStrategyName | 'service';
  /** access token 的 jti（登出进黑名单用） */
  jti?: string;
  /** 所属 refresh 轮换族（登出按族撤销当前设备会话） */
  fam?: string;
  /** access token 过期时间戳（秒） */
  exp?: number;
  /** 是否为服务账号 */
  isService?: boolean;
}

/** 双 token 响应结构（登录 / 注册 / 刷新统一返回） */
export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  /** access 剩余有效秒数 */
  expiresIn: number;
}

/** 登录 / 刷新结果 */
export interface LoginResult extends TokenPair {
  user: RequestUser;
}

/** GET /api/v1/auth/me 响应（供前端按钮级权限渲染） */
export interface MeResult {
  id: ID;
  username: string;
  nickname: string | null;
  avatar: string | null;
  roles: string[];
  permissions: PermissionCode[];
  dataScope: DataScope;
}

/** 菜单节点（后台动态路由数据源；`permissionCode` 为 null 表示登录即可见） */
export interface MenuNode {
  id: ID;
  name: string;
  path: string | null;
  component: string | null;
  icon: string | null;
  permissionCode: PermissionCode | null;
  visible: boolean;
  sort: number;
  children: MenuNode[];
}

/**
 * `@Permissions(...codes)` 语义（冻结）：
 * - 多个权限码为**与**关系（全部命中才放行），不支持「或」写法；
 * - 校验发生在业务处理器之前，因此响应不泄漏资源是否存在；
 * - 与类级/方法级 `@Public()` 同时存在时以 `@Public()` 优先（该方法不参与鉴权）。
 */
export interface PermissionsDecoratorContract {
  /** 声明的权限码（与关系） */
  codes: PermissionCode[];
}

/**
 * 守卫失败语义（与 `docs/40-api-spec.md` §2 错误码表同源）
 * | 场景 | 业务码 | HTTP |
 * |---|---|---|
 * | 未携带凭证 / 凭证无效 / 黑名单命中 / 用户级水位之后签发 | 3001 | 401 |
 * | 令牌已过期 | 3003 | 401 |
 * | 账号被锁定（连续失败）或已禁用 | 3004 | 403 |
 * | 权限不足 | 3002 | 403 |
 * | 触发登录限流 | 9003 | 429 |
 */
export interface GuardFailureContract {
  /** 未登录或令牌无效 */
  UNAUTHORIZED: 3001;
  /** 无操作权限 */
  FORBIDDEN: 3002;
  /** 令牌已过期 */
  TOKEN_EXPIRED: 3003;
  /** 账号已锁定或禁用 */
  ACCOUNT_LOCKED: 3004;
}

/** 免认证路径前缀（探针 / 指标；运维面直接访问，不参与鉴权） */
export declare const DEFAULT_PUBLIC_PATHS: readonly ['/health', '/ready', '/metrics'];

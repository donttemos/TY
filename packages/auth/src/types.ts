/*
 * @file 鉴权领域类型与契约结构
 * @description 定义 @fw/auth 的公开类型：实体结构（与 docs/30-data-dictionary.md §3.1~3.13 对齐）、
 *   RequestUser 请求用户结构（契约 C-05）、菜单树节点、令牌与审计记录结构。
 *   本文件为「类型即契约」的唯一来源，实现方与消费方（前端/生成器）照抄签名。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo BUG-15：UserQuery 新增 sort（由 HTTP 层 parseSortQuery 按字段白名单解析后注入；
 *   未传时存储层按 createdAt desc + id asc 的默认排序，保证分页 tie-breaker 稳定）
 * @module @fw/auth
 */

import type { PageResult, Sort } from '@fw/db';

/** 主键类型（框架统一字符串主键，与 M2 UUID 约定一致） */
export type ID = string;

/** 权限点类型：菜单 / 按钮 / 接口 */
export type PermissionType = 'menu' | 'button' | 'api';

/** 数据范围四档（PRD-003 FR-10，M3 仅实现 self，其余 M8 随组织架构扩展） */
export type DataScope = 'all' | 'org_below' | 'org' | 'self';

/** 认证策略名（PRD-003 FR-06） */
export type AuthStrategyName = 'jwt' | 'session' | 'oauth2' | 'apikey';

/** 令牌类型 */
export type TokenType = 'access' | 'refresh';

/** 账号状态：0 禁用 / 1 启用（与数据字典 users.status 同源） */
export type UserStatus = 0 | 1;

/** 用户（存储层结构，含口令哈希，禁止直接返回给前端） */
export interface AuthUser {
  id: ID;
  /** 租户归属；旧单租户应用可不设置 */
  tenantId?: string;
  username: string;
  phone: string | null;
  email: string | null;
  /** Argon2id 哈希（bcrypt 兼容迁移期可能存在 $2a$/$2b$ 前缀） */
  passwordHash: string;
  nickname: string | null;
  avatar: string | null;
  status: number;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
}

/** 角色 */
export interface AuthRole {
  id: ID;
  /** 角色编码，如 admin */
  code: string;
  name: string;
  /** 数据范围 */
  dataScope: DataScope;
  /** 内置角色：不可删除 */
  isSystem: boolean;
}

/** 权限点 */
export interface AuthPermission {
  id: ID;
  /** 权限码 `资源:操作`，如 order:refund */
  code: string;
  name: string;
  type: PermissionType;
  module: string | null;
}

/** 菜单（供后台动态路由） */
export interface AuthMenu {
  id: ID;
  /** 父菜单 ID，'0' 为顶级 */
  parentId: string;
  name: string;
  path: string | null;
  component: string | null;
  icon: string | null;
  /** 关联权限码：命中方可，null 表示登录即可见 */
  permissionCode: string | null;
  visible: boolean;
  sort: number;
}

/** 菜单树节点 */
export interface MenuNode extends Omit<AuthMenu, 'parentId'> {
  children: MenuNode[];
}

/** 刷新令牌记录（存储层结构，token 只存哈希） */
export interface RefreshTokenRecord {
  id: ID;
  userId: ID;
  /** 令牌 sha256 哈希（不存明文） */
  tokenHash: string;
  /** 轮换族 ID：族内出现复用即判定泄漏 */
  familyId: string;
  expireAt: Date;
  revokedAt: Date | null;
  loginIp: string | null;
  userAgent: string | null;
  /**
   * 本记录轮换出的 replacement 记录 ID（ADR-0020 Rule 5）。
   * 仅「已被 CAS 轮换」的记录持有；明文令牌永不落库，grace 恢复靠 replacementCipher。
   */
  replacedById: string | null;
  /** replacement 明文的 AES-256-GCM 密文（ADR-0020 Rule 7，grace 恢复专用；未轮换为 null） */
  replacementCipher: string | null;
  /** replacement 密文所用密钥标识（M11.1 单密钥 `replacement-v1`；M11.4 Key Ring 扩展） */
  replacementKeyId: string | null;
  /** replacement 密文可恢复期终点（= 轮换时刻 + grace，ADR-0020 时间基准；未轮换为 null） */
  replacementExpiresAt: Date | null;
}

/** 审计动作 */
export type AuditAction = 'create' | 'update' | 'delete' | 'login' | 'logout' | 'export' | 'grant';

/** 审计日志记录（数据字典 §3.13） */
export interface AuditLogRecord {
  id: ID;
  /** 操作人；系统任务为 null */
  userId: ID | null;
  module: string;
  action: AuditAction;
  targetType: string | null;
  targetId: string | null;
  /** 变更前（已脱敏） */
  beforeValue: unknown | null;
  /** 变更后（已脱敏） */
  afterValue: unknown | null;
  ip: string | null;
  userAgent: string | null;
  traceId: string | null;
  createdAt: Date;
}

/** 新建用户入参 */
export interface CreateUserInput {
  username: string;
  passwordHash: string;
  phone?: string;
  email?: string;
  nickname?: string;
}

/** 请求用户（写入 request.user 与请求上下文，契约 C-05） */
export interface RequestUser {
  /** 主体 ID：登录用户为用户 ID；API Key / 服务账号为 `apikey:<主体名>` */
  id: ID;
  tenantId?: string;
  /** 账号名（服务账号为主体名） */
  username: string;
  /** 角色编码列表（服务账号为空数组） */
  roles: string[];
  /** 权限码列表（已解析、已缓存） */
  permissions: string[];
  /** 生效的数据范围（多角色取最宽） */
  dataScope: DataScope;
  /** 本次请求的认证方式 */
  via: AuthStrategyName;
  /** 令牌唯一标识（jwt 策略有值，用于黑名单校验） */
  jti?: string;
  /** 令牌类型（jwt 策略有值） */
  tokenType?: TokenType;
  /** 所属 refresh 轮换族 ID（登出按族撤销当前设备会话） */
  fam?: string;
  /** access token 过期时间戳（秒级；登出时用作黑名单 TTL） */
  exp?: number;
  /** 是否为服务账号（API Key / OAuth2 客户端） */
  isService?: boolean;
}

/** 双 token 响应结构 */
export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  /** access 剩余有效秒数 */
  expiresIn: number;
}

/** 登录结果 */
export interface LoginResult extends TokenPair {
  user: RequestUser;
}

/** 当前用户信息（GET /auth/me） */
export interface MeResult {
  id: ID;
  username: string;
  nickname: string | null;
  avatar: string | null;
  roles: string[];
  permissions: string[];
  dataScope: DataScope;
}

/** 分页查询入参（审计查询等） */
export interface PageParams {
  page: number;
  pageSize: number;
}

/** 审计查询入参 */
export interface AuditQuery extends PageParams {
  userId?: ID;
  /**
   * 归属人 ID 集合（M8 T-M8-04）：userId 命中其中任一即返回（OR 语义）。
   * 由数据范围解析注入（org / org_below 档展开部门成员），**禁止**来自客户端入参。
   * 与 userId 同时传入时取交集（都不命中即空结果）。
   */
  userIds?: ID[];
  module?: string;
  action?: AuditAction;
  targetType?: string;
  targetId?: string;
  /** 起始时间（含） */
  from?: Date;
  /** 结束时间（含） */
  to?: Date;
  /**
   * 排序（BUG-15）：实体字段名 → 方向。由 HTTP 层 `parseSortQuery` 按白名单解析后注入
   * （未知字段在前置校验即 400，不会到达存储层）。未传时按 `createdAt desc, id asc` 排序。
   * 存储层须始终追加主键 tie-breaker，保证分页结果稳定（TC-ORM-002）。
   */
  sort?: Sort<AuditLogRecord>;
}

/** 用户列表查询入参 */
export interface UserQuery extends PageParams {
  keyword?: string;
  status?: number;
  roleId?: ID;
  /**
   * 排序（BUG-15）：实体字段名 → 方向。由 HTTP 层 `parseSortQuery` 按白名单解析后注入
   * （未知字段在前置校验即 400，不会到达存储层）。未传时按 `createdAt desc, id asc` 排序。
   * 存储层须始终追加主键 tie-breaker，保证分页结果稳定（TC-ORM-002）。
   */
  sort?: Sort<UserListItem>;
  /**
   * 可见部门 ID 集合（M8 T-M8-04）：用户属于其中任一部门即命中（OR 语义）。
   * 由数据范围解析注入（org / org_below 档），**禁止**来自客户端入参——否则可越权放宽范围。
   */
  departmentIds?: ID[];
}

/**
 * 用户列表项（不含口令哈希）
 * C-06 前端 API 契约 §3.3：列表必须带 roleIds（分配角色弹窗预选，避免逐行拉详情）与 createdAt。
 * 这两项不在 AuthUser 上（AuthUser 是登录态实体），由存储层在列表投影时补齐。
 */
export type UserListItem = Omit<AuthUser, 'passwordHash'> & {
  /** 持有的角色 ID 列表 */
  roleIds: ID[];
  /** 创建时间 */
  createdAt: Date | null;
};

/** 服务端鉴权配置（由环境变量映射，见 AuthModuleOptions） */
export interface AuthOptions {
  /** 默认认证策略（AUTH_STRATEGY） */
  strategy: AuthStrategyName;
  /** access token 有效期（秒） */
  accessTtlSeconds: number;
  /** refresh token 有效期（秒） */
  refreshTtlSeconds: number;
  /** 登录失败锁定阈值（AUTH_MAX_FAILED） */
  maxFailed: number;
  /** 锁定时长（分钟，AUTH_LOCK_MINUTES） */
  lockMinutes: number;
  /** refresh 并发宽限窗口（秒，AUTH_REFRESH_GRACE_SECONDS） */
  refreshGraceSeconds: number;
  /** 密码强度策略（AUTH_PASSWORD_POLICY） */
  passwordPolicy: PasswordPolicy;
  /** 是否开放自助注册（AUTH_ALLOW_REGISTER） */
  allowRegister: boolean;
  /** JWT 签名密钥（JWT_SECRET） */
  jwtSecret: string;
  /** 上一版 JWT 签名密钥（JWT_SECRET_PREV），轮换过渡期用于验签旧令牌 */
  jwtSecretPrev?: string;
  /** API Key 列表（AUTH_API_KEYS）：key → 主体名与权限码 */
  apiKeys: ApiKeyEntry[];
  /**
   * API Key 签名密钥（AUTH_API_KEY_SIGN_SECRET，E-07）：配置后 apikey 策略强制验签
   * （`X-Api-Timestamp` + `X-Api-Sign`，约定见 docs/41）；缺省仅验 key（向后兼容）。
   */
  apiKeySignSecret?: string;
  /**
   * OAuth2 提供方配置（AUTH_OAUTH2_PROVIDERS，E-07）：授权码客户端所需端点与凭据，
   * JSON 对象串解析（provider → 配置）；空串 = 未启用任何提供方。
   */
  oauth2Providers: OAuth2ProviderConfig[];
  /**
   * OAuth2 回调地址白名单（AUTH_OAUTH2_REDIRECT_WHITELIST，E-07）：
   * authorize 端点只接受前缀命中白名单的 redirect_uri（NFR 安全：回调域名白名单）；
   * 空 = 拒绝一切回调地址（默认安全）。
   */
  oauth2RedirectWhitelist: string[];
  /** 登录接口限流：窗口秒数与窗口内最大次数 */
  loginRateLimit: { windowSeconds: number; max: number };
  /** 权限缓存 TTL（秒） */
  permissionCacheTtlSeconds: number;
  /** 无需认证即可访问的路径前缀（探针与指标；默认 /health、/ready、/metrics） */
  publicPaths: string[];
}

/** API Key 条目（AUTH_API_KEYS 解析结果） */
export interface ApiKeyEntry {
  /** 密钥明文（仅内存持有，不落库、不写日志） */
  key: string;
  /** 主体名（写入 RequestUser.username） */
  subject: string;
  /** 授权权限码；空数组表示无任何权限（默认拒绝） */
  scopes: string[];
}

/**
 * OAuth2 提供方配置（E-07 授权码客户端，AUTH_OAUTH2_PROVIDERS JSON 单条）
 * 语义：标准 RFC 6749 授权码流程四端点 + 客户端凭据；scope 可选。
 */
export interface OAuth2ProviderConfig {
  /** 提供方名（authorize/callback 路由段；须匹配 ^[a-z][a-z0-9_-]{0,31}$） */
  provider: string;
  /** 客户端 ID（IdP 签发） */
  clientId: string;
  /** 客户端密钥（仅服务端持有，不进日志） */
  clientSecret: string;
  /** IdP 授权端点（浏览器 302 目标） */
  authorizeUrl: string;
  /** IdP 令牌端点（code 换 access_token） */
  tokenUrl: string;
  /** IdP 用户信息端点（Bearer token 拉取身份声明） */
  userInfoUrl: string;
  /** 申请的 scope（空格分隔，可省略） */
  scope?: string;
}

/** 密码强度策略档位 */
export type PasswordPolicy = 'low' | 'medium' | 'high';

/** 类型别名：审计分页结果 */
export type AuditPage = PageResult<AuditLogRecord>;

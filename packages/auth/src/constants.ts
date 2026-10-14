/*
 * @file 鉴权常量与默认值
 * @description 权限码清单（与 docs/40-api-spec.md §3 权限点列同源）、认证策略名、元数据键与各项默认参数。
 *   新增权限点必须同步 docs/40-api-spec.md 与本文件，避免前后端权限不同源（PRD-003 FR-04/FR-09）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo C-06 收口：新增 dict:read / dict:write / auth:revoke-session（补齐管理后台契约声明的权限点）
 * @module @fw/auth
 */

import type { AuthStrategyName } from './types.js';

/** 路由元数据键：@Public / @Permissions / @AuthStrategy 写入的 reflector key */
export const META_PUBLIC = 'fw:auth:public';
export const META_PERMISSIONS = 'fw:auth:permissions';
export const META_STRATEGY = 'fw:auth:strategy';
export const META_AUDIT = 'fw:audit:meta';
export const META_IGNORE_TENANT = 'fw:ignore-tenant';

/** 内置权限码（PRD-003 §3.2 / §3.3 / §3.4） */
export const PERM = {
  TENANT_IGNORE: 'system:tenant:ignore',
  /** 登出 */
  AUTH_LOGOUT: 'auth:logout',
  /** 当前用户资料 */
  AUTH_ME: 'auth:me',
  /** 修改密码 */
  AUTH_CHANGE_PASSWORD: 'auth:change-password',
  /** 用户读 */
  USER_READ: 'user:read',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
  /** 分配角色 */
  USER_ASSIGN_ROLE: 'user:assign-role',
  /** 重置他人密码 */
  USER_RESET_PASSWORD: 'user:reset-password',
  /** 角色读 / 建 / 改 / 删 / 授权 */
  ROLE_READ: 'role:read',
  ROLE_CREATE: 'role:create',
  ROLE_UPDATE: 'role:update',
  ROLE_DELETE: 'role:delete',
  ROLE_GRANT: 'role:grant',
  /** 权限点读 */
  PERMISSION_READ: 'permission:read',
  /** 菜单读 / 建 / 改 / 删 */
  MENU_READ: 'menu:read',
  MENU_CREATE: 'menu:create',
  MENU_UPDATE: 'menu:update',
  MENU_DELETE: 'menu:delete',
  /** 审计日志查询 */
  AUDIT_READ: 'audit:read',
  /** 字典读 / 维护（PRD-005 FR-07：字典项避免前端硬编码枚举） */
  DICT_READ: 'dict:read',
  DICT_WRITE: 'dict:write',
  /** 下线本人登录设备 */
  AUTH_REVOKE_SESSION: 'auth:revoke-session',
} as const;

/** 权限码字面量类型 */
export type PermissionCode = (typeof PERM)[keyof typeof PERM];

/** 内置角色编码 */
export const ROLE = {
  /** 超级管理员：拥有全部权限 */
  ADMIN: 'admin',
  /** 普通用户：仅自身相关 */
  USER: 'user',
} as const;

/** 默认认证策略（AUTH_STRATEGY 缺省值，与 @fw/config 对齐） */
export const DEFAULT_STRATEGY: AuthStrategyName = 'jwt';

/** 令牌默认有效期（秒）：access 2h / refresh 7d（PRD-003 FR-02） */
export const DEFAULT_ACCESS_TTL_SECONDS = 2 * 60 * 60;
export const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 登录失败默认阈值与锁定时长（PRD-003 FR-07） */
export const DEFAULT_MAX_FAILED = 5;
export const DEFAULT_LOCK_MINUTES = 15;

/** refresh 并发宽限窗口默认秒数（PRD-003 §8 风险缓解） */
export const DEFAULT_REFRESH_GRACE_SECONDS = 10;

/** 登录接口默认限流：60 秒内 10 次 */
export const DEFAULT_LOGIN_RATE_LIMIT = { windowSeconds: 60, max: 10 };

/** 权限缓存默认 TTL（秒）：权限变更按 user:* 标签主动失效 */
export const DEFAULT_PERMISSION_CACHE_TTL_SECONDS = 60;

/**
 * 默认免认证路径前缀：存活/就绪探针与指标端点由运维面暴露，
 * 不参与鉴权（PRD-001 要求探针可被编排系统直接访问）。
 */
export const DEFAULT_PUBLIC_PATHS = ['/health', '/ready', '/metrics'] as const;

/** 密码策略默认档位 */
export const DEFAULT_PASSWORD_POLICY = 'medium' as const;

/** 审计日志默认保留期（天，PRD-003 FR-08） */
export const DEFAULT_AUDIT_RETENTION_DAYS = 180;

/** JWT 签发者与算法 */
export const JWT_ISSUER = 'fw-auth';
export const JWT_ALG = 'HS256';

/** 敏感字段名（审计与日志落盘前一律脱敏，PRD-003 FR-08） */
export const SENSITIVE_FIELDS = [
  'password',
  'passwordHash',
  'oldPassword',
  'newPassword',
  'confirmPassword',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'privateKey',
] as const;

/** 脱敏占位符 */
export const MASKED = '***';

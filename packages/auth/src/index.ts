/*
 * @file @fw/auth 对外入口
 * @description 统一导出鉴权模块全部公共 API（服务、守卫、装饰器、端口、类型），禁止从深路径引用内部文件。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

// ---------- 模块装配 ----------
export { AuthModule, buildAuthOptions } from './auth.module.js';
export type { AuthEnvLike, AuthModuleOptions } from './auth.module.js';
export {
  AUTH_CACHE,
  AUTH_OAUTH2_FLOW,
  AUTH_OAUTH2_HANDLERS,
  AUTH_OPTIONS,
  AUTH_SESSION_STORE,
  AUTH_STORE,
  AUTH_STRATEGY_REGISTRY,
  DATA_SCOPE_ORG,
} from './tokens.js';

// ---------- 服务 ----------
export { AuthService } from './auth.service.js';
export type { AuthServiceDeps, ChangePasswordInput, LoginInput, RegisterInput } from './auth.service.js';
export { OAuth2FlowService, parseOAuth2Providers, parseRedirectWhitelist } from './oauth2-flow.js';
export type { OAuth2CallbackResult, OAuth2FlowOptions } from './oauth2-flow.js';
export { PasswordService, checkPasswordPolicy } from './password.service.js';
export type { PasswordCheck } from './password.service.js';
export { TokenService, TokenVerifyError } from './token.service.js';
export type {
  AccessClaims,
  IssuedToken,
  RefreshClaims,
  TokenServiceOptions,
  TokenVerifyReason,
  VerifyResult,
} from './token.service.js';
export { RefreshTokenService, hashToken } from './refresh-token.service.js';
export type { RotationOutcome } from './refresh-token.service.js';
export { TokenBlacklist, BLACKLIST_PREFIX, CUTOFF_PREFIX } from './token-blacklist.js';
export { PermissionService } from './permission.service.js';
export type { UserAuthContext } from './permission.service.js';
export { resolveDataScope, resolveDataScopeFilter, assertWithinDataScope } from './data-scope.js';
export type { DataScopeFilter, DataScopeOrgPort } from './data-scope.js';
export { collectDescendantIds } from './org-tree.js';
export type { OrgTreeNode } from './org-tree.js';
export { AuditService, sanitizeForAudit } from './audit.service.js';
export type { AuditEntry } from './audit.service.js';
export { AuditInterceptor } from './audit.interceptor.js';
export { LoginSecurity } from './login-security.js';
export type { FailureOutcome, LockState, LoginSecurityOptions } from './login-security.js';
export { parseDurationSeconds } from './duration.js';

// ---------- 缓存与存储端口 ----------
export { MemoryAuthCache } from './auth-cache.js';
export type { AuthCachePort } from './auth-cache.js';
export { MemoryAuthStore } from './memory-auth-store.js';
export type { AuthStore, NewAuditLog, NewRefreshToken } from './auth-store.js';

// ---------- 策略 ----------
export {
  ApiKeyStrategy,
  JwtStrategy,
  OAuth2Strategy,
  SessionStrategy,
  StrategyRegistry,
  apiKeySignature,
  parseApiKeys,
} from './strategies.js';
export type {
  AuthRequest,
  AuthStrategy,
  OAuth2Context,
  OAuth2Handler,
  SessionStore,
  StrategyIdentity,
} from './strategies.js';

// ---------- 守卫与装饰器 ----------
export { RbacGuard } from './rbac.guard.js';
export type { GuardRequest } from './rbac.guard.js';
export { Audit, AuthStrategy as AuthStrategyDecorator, CurrentUser, IgnoreTenant, Permissions, Public } from './decorators.js';
export type { AuditMeta } from './decorators.js';

// ---------- 常量与类型 ----------
export { PERM, ROLE, MASKED, SENSITIVE_FIELDS, META_AUDIT, META_IGNORE_TENANT, META_PERMISSIONS, META_PUBLIC, META_STRATEGY, DEFAULT_PUBLIC_PATHS, DEFAULT_OAUTH2_STATE_TTL_SECONDS, DEFAULT_API_KEY_SIGN_SKEW_SECONDS, OAUTH2_STATE_CACHE_PREFIX } from './constants.js';
export type { PermissionCode } from './constants.js';
export type {
  AuditAction,
  AuditLogRecord,
  AuditPage,
  AuditQuery,
  AuthMenu,
  AuthOptions,
  AuthPermission,
  AuthRole,
  AuthStrategyName,
  AuthUser,
  ApiKeyEntry,
  CreateUserInput,
  DataScope,
  ID,
  LoginResult,
  MeResult,
  MenuNode,
  OAuth2ProviderConfig,
  PageParams,
  PasswordPolicy,
  PermissionType,
  RefreshTokenRecord,
  RequestUser,
  TokenPair,
  TokenType,
  UserListItem,
  UserQuery,
  UserStatus,
} from './types.js';

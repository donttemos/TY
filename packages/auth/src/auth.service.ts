/*
 * @file 鉴权用例编排服务
 * @description PRD-003 的业务入口：注册 / 登录 / 刷新 / 登出 / 改密 / 当前用户 / 菜单树 / 授权变更 / 审计查询。
 *   守卫负责「每次请求的身份与权限」，本服务负责「显式触发的鉴权动作」，两者共享 TokenService、
 *   PermissionService 与 AuthStore，避免逻辑重复。
 *   安全要点：账号不存在与密码错误返回同一文案（防账号枚举）；锁定判定先于密码校验；
 *   改密成功后作废旧会话并为当前设备签发新令牌（其它设备下线，PRD-003 FR-01）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo assignUserRoles / grantRolePermissions 写库前校验 ID 集合（assertRoleIds / assertPermissionIds），杜绝空串或失效 ID 静默写库导致权限归零
 * @module @fw/auth
 */

import { BizError, ErrorCode } from '@fw/core';
import { Logger } from '@fw/logger';
import type { AuditPage, AuditQuery, AuthOptions, ID, LoginResult, MenuNode, MeResult, RequestUser, TokenPair } from './types.js';
import type { AuthStore } from './auth-store.js';
import type { AuditService } from './audit.service.js';
import type { LoginSecurity } from './login-security.js';
import type { PasswordService } from './password.service.js';
import type { PermissionService } from './permission.service.js';
import type { RefreshTokenService } from './refresh-token.service.js';
import type { TokenBlacklist } from './token-blacklist.js';
import type { TokenService } from './token.service.js';

const logger = Logger.for('auth.service');

/** 账号名规则：3-32 位字母数字与 _ . - */
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

/** 登录入参 */
export interface LoginInput {
  /** 账号：用户名 / 手机号 / 邮箱 */
  account: string;
  /** 明文密码 */
  password: string;
  /** 来源 IP */
  ip: string;
  /** 客户端标识 */
  userAgent?: string | null;
}

/** 注册入参 */
export interface RegisterInput {
  username: string;
  password: string;
  phone?: string;
  email?: string;
  nickname?: string;
  ip: string;
  userAgent?: string | null;
}

/** 改密入参 */
export interface ChangePasswordInput {
  userId: ID;
  oldPassword: string;
  newPassword: string;
  ip: string;
  userAgent?: string | null;
}

/** AuthService 依赖集合（由 AuthModule 装配） */
export interface AuthServiceDeps {
  store: AuthStore;
  passwords: PasswordService;
  tokens: TokenService;
  refresh: RefreshTokenService;
  blacklist: TokenBlacklist;
  security: LoginSecurity;
  permissions: PermissionService;
  audit: AuditService;
  options: AuthOptions;
}

/**
 * 鉴权服务
 */
export class AuthService {
  /**
   * @param deps 依赖集合
   */
  constructor(private readonly deps: AuthServiceDeps) {}

  /**
   * 登录：限流 → 锁定检查 → 口令校验 → 签发双 token → 审计
   * @param input 账号、密码、来源信息
   * @returns 双 token 与请求用户
   * @throws BizError 9003 限流 / 3004 锁定 / 3001 账号或密码错误
   */
  async login(input: LoginInput): Promise<LoginResult> {
    const { store, passwords, security, audit, options } = this.deps;
    await security.assertRateLimit(input.ip);

    const lock = await security.checkLock(input.ip, input.account);
    if (lock.locked) {
      logger.warn('账号处于锁定状态，拒绝登录', { account: input.account, ip: input.ip });
      throw new BizError(ErrorCode.ACCOUNT_LOCKED, `账号已锁定，请 ${Math.ceil(lock.retryAfterSeconds / 60)} 分钟后重试`);
    }

    const user = await store.findUserByAccount(input.account);
    if (!user) {
      await security.recordFailure(input.ip, input.account);
      // 账号不存在与密码错误同文案，避免账号枚举
      throw new BizError(ErrorCode.UNAUTHORIZED, '账号或密码错误');
    }
    if (user.status !== 1) {
      logger.warn('账号已禁用，拒绝登录', { userId: user.id });
      throw new BizError(ErrorCode.ACCOUNT_LOCKED, '账号已禁用，请联系管理员');
    }

    const ok = await passwords.verify(user.passwordHash, input.password);
    if (!ok) {
      const outcome = await security.recordFailure(input.ip, input.account);
      if (outcome.locked) {
        throw new BizError(
          ErrorCode.ACCOUNT_LOCKED,
          `连续失败 ${outcome.failed} 次，账号已锁定 ${Math.ceil(outcome.lockSeconds / 60)} 分钟`,
        );
      }
      throw new BizError(ErrorCode.UNAUTHORIZED, '账号或密码错误');
    }

    // bcrypt → Argon2id 静默升级（PRD-003 待定问题结论）
    if (passwords.needsRehash(user.passwordHash)) {
      const upgraded = await passwords.hash(input.password);
      await store.updateUser(user.id, { passwordHash: upgraded });
      logger.info('口令哈希已升级为 Argon2id', { userId: user.id });
    }

    await security.clear(input.ip, input.account);
    await store.touchUserLogin(user.id, new Date(), input.ip);

    const permissions = await this.deps.permissions.getUserContext(user.id);
    const result = await this.issueSession({
      id: user.id,
      username: user.username,
      roles: permissions.roles,
      ip: input.ip,
      userAgent: input.userAgent ?? null,
    });

    audit.record({
      userId: user.id,
      module: 'auth',
      action: 'login',
      targetType: 'user',
      targetId: user.id,
      ip: input.ip,
      userAgent: input.userAgent ?? null,
    });
    logger.info('登录成功', { userId: user.id, username: user.username, ip: input.ip, policy: options.passwordPolicy });
    return result;
  }

  /**
   * 注册：可开关 → 账号规则 → 强度策略 → 唯一性 → 落库并授予默认角色
   * @param input 注册信息
   * @returns 新用户 ID 与账号名
   * @throws BizError 1004 注册关闭 / 1003 账号已存在 / 1001 参数或强度不合法
   */
  async register(input: RegisterInput): Promise<{ id: ID; username: string }> {
    const { store, passwords, options, audit } = this.deps;
    if (!options.allowRegister) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '注册功能已关闭，请联系管理员开通账号');
    }
    const username = input.username?.trim() ?? '';
    if (!USERNAME_RE.test(username)) {
      throw new BizError(ErrorCode.BAD_REQUEST, '用户名需为 3-32 位字母、数字、下划线、点或短横线');
    }
    const strength = passwords.check(input.password, options.passwordPolicy);
    if (!strength.ok) {
      throw new BizError(
        ErrorCode.BAD_REQUEST,
        '密码强度不足',
        strength.issues.map((message, index) => ({ field: index === 0 ? 'password' : `password[${index}]`, message })),
      );
    }
    for (const account of [username, input.phone, input.email].filter(Boolean) as string[]) {
      if (await store.findUserByAccount(account)) {
        throw new BizError(ErrorCode.CONFLICT, `账号已存在：${account}`);
      }
    }

    const created = await store.createUser({
      username,
      passwordHash: await passwords.hash(input.password),
      phone: input.phone,
      email: input.email,
      nickname: input.nickname,
    });
    // 默认授予内置 user 角色（存在时），保证新账号有最小可见范围而非无权限死锁
    const roles = await store.listRoles();
    const fallback = roles.find((role) => role.code === 'user');
    if (fallback) await store.replaceUserRoles(created.id, [fallback.id]);

    audit.record({
      userId: created.id,
      module: 'auth',
      action: 'create',
      targetType: 'user',
      targetId: created.id,
      ip: input.ip,
      userAgent: input.userAgent ?? null,
      after: { username: created.username, phone: created.phone, email: created.email },
    });
    logger.info('注册成功', { userId: created.id, username: created.username });
    return { id: created.id, username: created.username };
  }

  /**
   * 刷新：轮换 refresh（旧令牌失效 / 复用检测见 RefreshTokenService），签发新 access
   * @param refreshToken refresh 明文
   * @param ip 来源 IP
   * @param userAgent 客户端标识
   * @returns 新双 token 与请求用户
   * @throws BizError 3001 无效或泄漏 / 3003 过期
   */
  async refreshSession(refreshToken: string, ip: string, userAgent?: string | null): Promise<LoginResult> {
    const { store, tokens, refresh, permissions } = this.deps;
    const rotated = await refresh.rotate(refreshToken, ip, userAgent ?? null);

    const user = await store.findUserById(rotated.outcome.userId);
    if (!user || user.status !== 1) {
      await refresh.revokeAllForUser(rotated.outcome.userId);
      throw new BizError(ErrorCode.UNAUTHORIZED, '账号不可用，已终止会话');
    }

    const context = await permissions.getUserContext(user.id);
    const access = await tokens.signAccess({ id: user.id, username: user.username, roles: context.roles });
    const pair: TokenPair = {
      tokenType: 'Bearer',
      accessToken: access.token,
      refreshToken: rotated.refreshToken,
      expiresIn: access.expiresIn,
    };
    logger.info('刷新令牌完成轮换', {
      userId: user.id,
      familyId: rotated.outcome.familyId,
      withinGrace: rotated.outcome.withinGrace,
    });
    return { ...pair, user: this.toRequestUser(user.id, user.username, context, 'jwt', { jti: access.jti, fam: rotated.outcome.familyId, exp: access.exp }) };
  }

  /**
   * 登出：当前 access 进黑名单 + 撤销该 refresh 族（仅当前设备）；无法定位族时降级为清空该用户全部 refresh
   * @param user 当前请求用户（含 jti / fam / exp）
   * @param expiresAt access 过期时间戳（秒）；缺省取 user.exp
   * @param ip 来源 IP
   * @param userAgent 客户端标识
   * @returns 一并撤销的 refresh 条数
   */
  async logout(
    user: RequestUser,
    expiresAt: number | undefined,
    ip: string,
    userAgent?: string | null,
  ): Promise<{ revokedRefreshTokens: number }> {
    const { blacklist, refresh, audit, tokens } = this.deps;
    const exp = expiresAt ?? user.exp ?? Math.floor(Date.now() / 1000) + tokens.accessTtlSeconds;
    if (user.jti) await blacklist.revoke(user.jti, exp);
    const revoked = user.fam ? await refresh.revokeFamily(user.fam) : await refresh.revokeAllForUser(user.id);
    audit.record({
      userId: user.id,
      module: 'auth',
      action: 'logout',
      targetType: 'user',
      targetId: user.id,
      ip,
      userAgent: userAgent ?? null,
      after: { revokedRefreshTokens: revoked, family: user.fam ?? null },
    });
    logger.info('登出完成', { userId: user.id, revokedRefreshTokens: revoked, family: user.fam ?? null });
    return { revokedRefreshTokens: revoked };
  }

  /**
   * 改密：校验旧密码与强度 → 更新哈希 → 终止其它会话 → 当前设备换新令牌
   * @param input 改密入参
   * @returns 当前设备的新双 token
   * @throws BizError 3001 旧密码错误 / 1001 强度不足
   */
  async changePassword(input: ChangePasswordInput): Promise<LoginResult> {
    const { store, passwords, tokens, refresh, blacklist, permissions, audit, options } = this.deps;
    const user = await store.findUserById(input.userId);
    if (!user) throw new BizError(ErrorCode.UNAUTHORIZED, '账号不存在');
    if (!(await passwords.verify(user.passwordHash, input.oldPassword))) {
      throw new BizError(ErrorCode.UNAUTHORIZED, '原密码错误');
    }
    if (input.oldPassword === input.newPassword) {
      throw new BizError(ErrorCode.BAD_REQUEST, '新密码不能与原密码相同');
    }
    const strength = passwords.check(input.newPassword, options.passwordPolicy);
    if (!strength.ok) {
      throw new BizError(
        ErrorCode.BAD_REQUEST,
        '密码强度不足',
        strength.issues.map((message, index) => ({ field: index === 0 ? 'newPassword' : `newPassword[${index}]`, message })),
      );
    }

    const before = { passwordHash: user.passwordHash };
    const updated = await store.updateUser(user.id, { passwordHash: await passwords.hash(input.newPassword) });
    // 其它设备下线：撤销全部 refresh，并把 access 水位抬到当前时刻（审计值敏感，走脱敏）
    const revoked = await refresh.revokeAllForUser(user.id);
    const nowSeconds = Math.floor(Date.now() / 1000);
    await blacklist.setUserCutoff(user.id, nowSeconds, tokens.accessTtlSeconds);

    const context = await permissions.getUserContext(user.id);
    const issued = await refresh.issue(user.id, input.ip, input.userAgent ?? null);
    const access = await tokens.signAccess({ id: user.id, username: updated.username, roles: context.roles }, issued.familyId);
    audit.record({
      userId: user.id,
      module: 'auth',
      action: 'update',
      targetType: 'user',
      targetId: user.id,
      before,
      after: { passwordHash: updated.passwordHash },
      ip: input.ip,
      userAgent: input.userAgent ?? null,
    });
    logger.info('修改密码成功，其它设备已下线', { userId: user.id, revokedRefreshTokens: revoked });
    return {
      tokenType: 'Bearer',
      accessToken: access.token,
      refreshToken: issued.refreshToken,
      expiresIn: access.expiresIn,
      user: this.toRequestUser(user.id, updated.username, context, 'jwt', { jti: access.jti, fam: issued.familyId, exp: access.exp }),
    };
  }

  /**
   * 强制某用户全部会话下线（管理员禁用账号 / 踢下线）
   * @param userId 目标用户
   * @param ip 触发者来源 IP
   * @param operator 操作人（审计；缺省记为目标用户自身）
   * @returns 撤销的 refresh 条数
   */
  async revokeUserSessions(userId: ID, ip: string, operator?: ID): Promise<{ revokedRefreshTokens: number }> {
    const { refresh, blacklist, tokens, audit } = this.deps;
    const revoked = await refresh.revokeAllForUser(userId);
    await blacklist.setUserCutoff(userId, Math.floor(Date.now() / 1000), tokens.accessTtlSeconds);
    audit.record({
      userId: operator ?? userId,
      module: 'auth',
      action: 'logout',
      targetType: 'user',
      targetId: userId,
      ip,
      after: { revokedRefreshTokens: revoked, reason: 'forced' },
    });
    logger.info('已强制用户全部会话下线', { userId, revokedRefreshTokens: revoked });
    return { revokedRefreshTokens: revoked };
  }

  /**
   * 当前用户资料 + 角色 + 权限码
   * @param userId 用户 ID
   * @returns 个人中心数据
   */
  async me(userId: ID): Promise<MeResult> {
    const user = await this.deps.store.findUserById(userId);
    if (!user) throw new BizError(ErrorCode.NOT_FOUND, '用户不存在');
    const context = await this.deps.permissions.getUserContext(user.id);
    return {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar,
      roles: context.roles,
      permissions: context.permissions,
      dataScope: context.dataScope,
    };
  }

  /**
   * 当前用户可见菜单树（前后端权限同源）
   * @param userId 用户 ID
   */
  async menus(userId: ID): Promise<MenuNode[]> {
    return this.deps.permissions.getMenuTree(userId);
  }

  /**
   * 审计日志查询
   * @param query 查询条件
   */
  async auditLogs(query: AuditQuery): Promise<AuditPage> {
    return this.deps.audit.page(query);
  }

  /**
   * 全量覆盖用户角色（角色变更后按 user 标签失效权限缓存，保证即时生效）
   * @param userId 用户 ID
   * @param roleIds 角色 ID 列表（必须先过 assertRoleIds 校验）
   * @param operator 操作人（审计）
   * @param ip 来源 IP
   * @returns 生效后的权限码
   */
  async assignUserRoles(userId: ID, roleIds: ID[], operator: ID, ip: string): Promise<{ permissions: string[] }> {
    await this.assertRoleIds(roleIds);
    await this.deps.store.replaceUserRoles(userId, roleIds);
    await this.deps.permissions.invalidateUser(userId);
    const context = await this.deps.permissions.getUserContext(userId);
    this.deps.audit.record({
      userId: operator,
      module: 'auth',
      action: 'grant',
      targetType: 'user_role',
      targetId: userId,
      after: { roleIds },
      ip,
    });
    return { permissions: context.permissions };
  }

  /**
   * 校验待分配的角色 ID 集合：非空串、全部存在且未删除
   *
   * 存在意义（真机事故复盘）：`replaceUserRoles` 是「先删后建」的全量覆盖，
   * 入参若含空串或已不存在的 ID 会被静默写库——用户的角色集随即被替换成
   * 「无效关联」，权限聚合直接归零，表现为全站 3002 且无从溯源。
   * 校验放在写库前，把「静默数据损坏」变成「明确 1001」。
   *
   * @param roleIds 待分配的角色 ID 列表
   * @throws BizError 1001 含空串 / 非字符串 / 不存在或已删除的 ID
   */
  async assertRoleIds(roleIds: ID[]): Promise<void> {
    const ids = [...new Set(roleIds)];
    const malformed = ids.filter((id) => typeof id !== 'string' || id.length === 0);
    if (malformed.length > 0) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'roleIds 含无效的角色 ID（空串或非字符串）');
    }
    const known = new Set((await this.deps.store.listRoles()).map((role) => role.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BizError(ErrorCode.BAD_REQUEST, `角色不存在或已删除：${unknown.join('、')}`);
    }
  }

  /**
   * 全量覆盖角色权限（角色权限变更即时生效：失效持有该角色用户的缓存）
   * @param roleId 角色 ID
   * @param permissionIds 权限点 ID 列表（必须先过 assertPermissionIds 校验）
   * @param operator 操作人（审计）
   * @param ip 来源 IP
   * @returns 受影响用户数
   */
  async grantRolePermissions(
    roleId: ID,
    permissionIds: ID[],
    operator: ID,
    ip: string,
  ): Promise<{ affectedUsers: number }> {
    await this.assertPermissionIds(permissionIds);
    await this.deps.store.replaceRolePermissions(roleId, permissionIds);
    const affected = await this.deps.store.listUserIdsByRoleId(roleId);
    await this.deps.permissions.invalidateUsers(affected);
    this.deps.audit.record({
      userId: operator,
      module: 'auth',
      action: 'grant',
      targetType: 'role_permission',
      targetId: roleId,
      after: { permissionIds },
      ip,
    });
    logger.info('角色权限已变更，相关用户缓存已失效', { roleId, affectedUsers: affected.length });
    return { affectedUsers: affected.length };
  }

  /**
   * 校验待授权的权限点 ID 集合：非空串、全部存在且未删除
   * 与 assertRoleIds 同源——`replaceRolePermissions` 同样是先删后建，
   * 无效 ID 会静默写进 role_permission，让角色拿到查不到的权限点。
   * @param permissionIds 待授权的权限点 ID 列表
   * @throws BizError 1001 含空串 / 非字符串 / 不存在或已删除的 ID
   */
  async assertPermissionIds(permissionIds: ID[]): Promise<void> {
    const ids = [...new Set(permissionIds)];
    const malformed = ids.filter((id) => typeof id !== 'string' || id.length === 0);
    if (malformed.length > 0) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'permissionIds 含无效的权限点 ID（空串或非字符串）');
    }
    const known = new Set((await this.deps.store.listPermissions()).map((permission) => permission.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BizError(ErrorCode.BAD_REQUEST, `权限点不存在或已删除：${unknown.join('、')}`);
    }
  }

  /**
   * 失效持有指定角色的用户权限缓存
   * 用途：角色**资料**变更（如 dataScope 调整）后即时生效——dataScope 不落 role_permission，
   * 不走 grantRolePermissions 的失效路径，须显式调用本方法，否则已登录用户仍持旧数据范围。
   * @param roleId 角色 ID
   * @returns 受影响用户数
   */
  async invalidateUsersOfRole(roleId: ID): Promise<{ affectedUsers: number }> {
    const affected = await this.deps.store.listUserIdsByRoleId(roleId);
    if (affected.length === 0) return { affectedUsers: 0 };
    await this.deps.permissions.invalidateUsers(affected);
    logger.info('角色资料已变更，相关用户缓存已失效', { roleId, affectedUsers: affected.length });
    return { affectedUsers: affected.length };
  }

  /** 组装请求用户（登录 / 刷新 / 改密共用） */
  private toRequestUser(
    id: ID,
    username: string,
    context: { roles: string[]; permissions: string[]; dataScope: RequestUser['dataScope'] },
    via: RequestUser['via'],
    token?: { jti: string; fam?: string; exp: number },
  ): RequestUser {
    return {
      id,
      username,
      roles: context.roles,
      permissions: context.permissions,
      dataScope: context.dataScope,
      via,
      jti: token?.jti,
      fam: token?.fam,
      exp: token?.exp,
      tokenType: 'access',
      isService: false,
    };
  }

  /** 签发会话：先建 refresh 族，再用同一族签发 access（便于按族精确撤销） */
  private async issueSession(params: {
    id: ID;
    username: string;
    roles: string[];
    ip: string;
    userAgent: string | null;
  }): Promise<LoginResult> {
    const { tokens, refresh } = this.deps;
    const issued = await refresh.issue(params.id, params.ip, params.userAgent);
    const access = await tokens.signAccess(
      { id: params.id, username: params.username, roles: params.roles },
      issued.familyId,
    );
    const context = await this.deps.permissions.getUserContext(params.id);
    const pair: TokenPair = {
      tokenType: 'Bearer',
      accessToken: access.token,
      refreshToken: issued.refreshToken,
      expiresIn: access.expiresIn,
    };
    return { ...pair, user: this.toRequestUser(params.id, params.username, context, 'jwt', { jti: access.jti, fam: issued.familyId, exp: access.exp }) };
  }
}

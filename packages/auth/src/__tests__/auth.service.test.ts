/*
 * @file 鉴权用例编排单测
 * @description 覆盖登录成功/失败/锁定/禁用（TC-AUTH-001/002）、账号枚举防护、注册开关与唯一性、
 *   刷新会话、登出黑名单、改密（其它设备下线 + 前后值审计）、me/菜单树、角色授权与权限缓存失效
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fw/core';
import { PERM, ROLE } from '../constants.js';
import { createHarness } from './test-helpers.js';
import { hashToken } from '../refresh-token.service.js';
import type { AuditLogRecord } from '../types.js';

/** 断言 BizError 错误码 */
async function expectCode(promise: Promise<unknown>, code: number): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('AuthService · 登录', () => {
  it('TC-AUTH-001：登录成功返回双 token，更新 last_login_at 并写登录审计', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const result = await h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.0.0.1', userAgent: 'jest' });

    expect(result.tokenType).toBe('Bearer');
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.expiresIn).toBe(7200);
    expect(result.user.roles).toEqual([ROLE.ADMIN]);
    expect(result.user.permissions).toContain(PERM.USER_READ);

    const user = await h.store.findUserById(seeded.admin.id);
    expect(user?.lastLoginAt).toBeInstanceOf(Date);
    expect(user?.lastLoginIp).toBe('10.0.0.1');

    const logs = await h.audit.page({ page: 1, pageSize: 10, action: 'login' });
    expect(logs.total).toBe(1);
    expect(logs.items[0].userId).toBe(seeded.admin.id);
  });

  it('支持手机号 / 邮箱登录；账号不存在与密码错误返回同一文案（防枚举）', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    await h.store.updateUser(seeded.normal.id, { phone: '13800000000', email: 'alice@example.com' });

    await expect(h.service.login({ account: '13800000000', password: 'Alice@12345', ip: '10.0.0.1' })).resolves.toBeTruthy();
    await expect(h.service.login({ account: 'alice@example.com', password: 'Alice@12345', ip: '10.0.0.1' })).resolves.toBeTruthy();

    const unknown = await h.service.login({ account: 'ghost', password: 'whatever', ip: '10.0.0.2' }).catch((e: Error) => e);
    const wrongPw = await h.service.login({ account: 'alice', password: 'wrong', ip: '10.0.0.3' }).catch((e: Error) => e);
    expect((unknown as { message: string }).message).toBe('账号或密码错误');
    expect((wrongPw as { message: string }).message).toBe('账号或密码错误');
  });

  it('TC-AUTH-002：连续 5 次密码错误后锁定，锁定期间即使密码正确也返回 3004', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    for (let i = 1; i <= 4; i += 1) {
      await expectCode(h.service.login({ account: 'admin', password: 'bad', ip: '10.0.0.1' }), ErrorCode.UNAUTHORIZED);
    }
    const fifth = await h.service.login({ account: 'admin', password: 'bad', ip: '10.0.0.1' }).catch((e: Error) => e);
    expect((fifth as { code: number }).code).toBe(ErrorCode.ACCOUNT_LOCKED);

    // 锁定期间正确密码同样被拒
    await expectCode(h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.0.0.1' }), ErrorCode.ACCOUNT_LOCKED);
    const locked = await h.security.checkLock('10.0.0.1', 'admin');
    expect(locked.locked).toBe(true);
  });

  it('禁用账号登录返回 3004；触发限流返回 9003', async () => {
    const h = createHarness({ loginRateLimit: { windowSeconds: 60, max: 2 } });
    const seeded = await h.seed();
    await h.store.updateUser(seeded.normal.id, { status: 0 });
    await expectCode(h.service.login({ account: 'alice', password: 'Alice@12345', ip: '10.0.0.1' }), ErrorCode.ACCOUNT_LOCKED);

    await h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.0.0.9' });
    await h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.0.0.9' });
    await expectCode(h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.0.0.9' }), ErrorCode.RATE_LIMITED);
  });

  it('bcrypt 历史哈希登录成功后静默升级为 Argon2id', async () => {
    const bcrypt = await import('bcryptjs');
    const h = createHarness();
    const legacyHash = bcrypt.default.hashSync('Legacy@12345', 8);
    const user = h.store.seedUser({
      username: 'legacy',
      phone: null,
      email: null,
      passwordHash: legacyHash,
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    await h.service.login({ account: 'legacy', password: 'Legacy@12345', ip: '10.0.0.1' });
    const after = await h.store.findUserById(user.id);
    expect(after?.passwordHash.startsWith('$argon2id$')).toBe(true);
  });
});

describe('AuthService · 注册', () => {
  it('注册关闭时返回 1004；弱密码返回 1001 且带字段级提示', async () => {
    const closed = createHarness({ allowRegister: false });
    await closed.seed();
    await expectCode(
      closed.service.register({ username: 'newbie', password: 'Strong@12345', ip: '10.0.0.1' }),
      ErrorCode.STATE_NOT_ALLOWED,
    );

    const h = createHarness({ passwordPolicy: 'high' });
    await h.seed();
    const error = await h.service
      .register({ username: 'newbie', password: 'weakpass', ip: '10.0.0.1' })
      .catch((e: { code: number; details?: Array<{ field: string }> }) => e);
    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
    expect(error.details?.length).toBeGreaterThan(0);
  });

  it('用户名规则与唯一性校验；成功后授予默认 user 角色并写审计', async () => {
    const h = createHarness();
    await h.seed();
    await expectCode(h.service.register({ username: 'ab', password: 'Strong@12345', ip: '10.0.0.1' }), ErrorCode.BAD_REQUEST);
    await expectCode(h.service.register({ username: 'admin', password: 'Strong@12345', ip: '10.0.0.1' }), ErrorCode.CONFLICT);

    const created = await h.service.register({ username: 'newbie', password: 'Strong@12345', ip: '10.0.0.1', nickname: '新人' });
    const roles = await h.store.listRolesByUserId(created.id);
    expect(roles.map((r) => r.code)).toEqual([ROLE.USER]);
    const logs = await h.audit.page({ page: 1, pageSize: 10, action: 'create' });
    expect(logs.total).toBe(1);
  });
});

describe('AuthService · 刷新 / 登出 / 改密', () => {
  it('刷新返回新双 token，旧 refresh 记录被撤销（TC-AUTH-006）；宽限窗口内复用不误判（TC-AUTH-008）', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const login = await h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.0.0.1' });
    const refreshed = await h.service.refreshSession(login.refreshToken, '10.0.0.1', 'jest');

    expect(refreshed.accessToken).not.toBe(login.accessToken);
    expect(refreshed.refreshToken).not.toBe(login.refreshToken);
    const oldRecord = await h.store.findRefreshTokenByHash(hashToken(login.refreshToken));
    expect(oldRecord?.revokedAt).not.toBeNull();

    // 宽限窗口内（默认 10s）复用旧 refresh：按并发刷新处理，返回同族新令牌
    const concurrent = await h.service.refreshSession(login.refreshToken, '10.0.0.1', 'jest');
    expect(concurrent.refreshToken).not.toBe(refreshed.refreshToken);
  });

  it('刷新时账号被禁用则终止该用户全部刷新令牌', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const login = await h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.0.0.1' });
    await h.store.updateUser(seeded.admin.id, { status: 0 });
    await expectCode(h.service.refreshSession(login.refreshToken, '10.0.0.1'), ErrorCode.UNAUTHORIZED);
    const record = await h.store.findRefreshTokenByHash(hashToken(login.refreshToken));
    expect(record?.revokedAt).not.toBeNull();
  });

  it('登出：access 进黑名单、当前设备 refresh 族被撤销（TC-AUTH-010）', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const login = await h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.0.0.1' });
    const verified = await h.tokens.verify(login.accessToken);
    const exp = typeof verified.claims.exp === 'number' ? verified.claims.exp : 0;

    const result = await h.service.logout(login.user, exp, '10.0.0.1', 'jest');
    expect(result.revokedRefreshTokens).toBe(1);
    expect(await h.blacklist.isRevoked(login.user.jti as string)).toBe(true);
    expect(await h.blacklist.isRevoked('other-jti')).toBe(false);
    const record = await h.store.findRefreshTokenByHash(hashToken(login.refreshToken));
    expect(record?.revokedAt).not.toBeNull();

    const logs = await h.audit.page({ page: 1, pageSize: 10, action: 'logout' });
    expect(logs.total).toBe(1);
  });

  it('改密：旧密码校验、强度与重复校验，成功后其它设备下线并返回当前设备新令牌', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const other = await h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.0.0.2' });
    const current = await h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.0.0.1' });

    await expectCode(
      h.service.changePassword({ userId: seeded.admin.id, oldPassword: 'bad', newPassword: 'NewStrong@123', ip: '10.0.0.1' }),
      ErrorCode.UNAUTHORIZED,
    );
    await expectCode(
      h.service.changePassword({ userId: seeded.admin.id, oldPassword: seeded.adminPassword, newPassword: 'weak', ip: '10.0.0.1' }),
      ErrorCode.BAD_REQUEST,
    );
    await expectCode(
      h.service.changePassword({
        userId: seeded.admin.id,
        oldPassword: seeded.adminPassword,
        newPassword: seeded.adminPassword,
        ip: '10.0.0.1',
      }),
      ErrorCode.BAD_REQUEST,
    );

    const result = await h.service.changePassword({
      userId: seeded.admin.id,
      oldPassword: seeded.adminPassword,
      newPassword: 'NewStrong@123',
      ip: '10.0.0.1',
    });
    expect(result.accessToken).toBeTruthy();
    // 其它设备的 refresh 全部失效
    expect((await h.store.findRefreshTokenByHash(hashToken(other.refreshToken)))?.revokedAt).not.toBeNull();
    expect((await h.store.findRefreshTokenByHash(hashToken(current.refreshToken)))?.revokedAt).not.toBeNull();
    // 新密码可登录、旧密码不可
    await expect(h.service.login({ account: 'admin', password: 'NewStrong@123', ip: '10.0.0.3' })).resolves.toBeTruthy();
    await expectCode(h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.0.0.4' }), ErrorCode.UNAUTHORIZED);

    // 审计记录了前后值，且哈希被脱敏
    const logs = await h.audit.page({ page: 1, pageSize: 10, action: 'update' });
    const record: AuditLogRecord = logs.items[0];
    expect((record.beforeValue as Record<string, unknown>).passwordHash).toBe('***');
    expect((record.afterValue as Record<string, unknown>).passwordHash).toBe('***');
  });
});

describe('AuthService · 查询与授权', () => {
  it('me 返回资料 + 角色 + 权限；menus 按权限过滤', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    const me = await h.service.me(seeded.normal.id);
    expect(me.username).toBe('alice');
    expect(me.permissions).toEqual([]);
    expect(me.dataScope).toBe('self');

    const adminMenus = await h.service.menus(seeded.admin.id);
    expect(adminMenus.map((m) => m.name)).toContain('订单退款');
    const userMenus = await h.service.menus(seeded.normal.id);
    expect(userMenus.map((m) => m.name)).toEqual(['控制台']);

    await expect(h.service.me('ghost')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('TC-AUTH-009：角色权限变更即时生效（缓存按 user 标签失效）', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    // 先让 alice 的权限进缓存
    expect((await h.permissions.getUserContext(seeded.normal.id)).permissions).toEqual([]);

    const readUser = h.store.seedPermission({ code: PERM.USER_READ, name: 'u', type: 'api', module: 'user' });
    const result = await h.service.grantRolePermissions(seeded.userRole.id, [readUser.id], seeded.admin.id, '10.0.0.1');
    expect(result.affectedUsers).toBe(1);
    expect((await h.permissions.getUserContext(seeded.normal.id)).permissions).toEqual([PERM.USER_READ]);
  });

  it('assignUserRoles 覆盖角色并失效缓存', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    expect((await h.permissions.getUserContext(seeded.normal.id)).roles).toEqual([ROLE.USER]);

    const result = await h.service.assignUserRoles(seeded.normal.id, [seeded.adminRole.id], seeded.admin.id, '10.0.0.1');
    expect(result.permissions).toContain(PERM.USER_DELETE);
    const roles = await h.store.listRolesByUserId(seeded.normal.id);
    expect(roles.map((r) => r.code)).toEqual([ROLE.ADMIN]);
  });
});

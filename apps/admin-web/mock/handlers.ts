/*
 * @file mock 请求处理器（C-06 前端 API 契约的 HTTP 实现）
 * @description 以 connect 中间件形式处理 /api/v1/*：统一响应信封 { code, message, data, traceId }、
 *   错误码表（docs/40-api-spec.md §2）、Bearer JWT 鉴权与权限点校验（未授权 3001 / 过期 3003 / 越权 3002）、
 *   refresh 轮换（复用即失效）。路由表与 API 规格 §3 对齐；分页参数 page/pageSize，软删除语义 DELETE。
 *   设计目标：mock 与真实后端响应结构零差异，切真实 API 只改 VITE_API_BASE_URL。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/mock
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  MockAuditLog,
  MockDb,
  MockDictCategory,
  MockDictItem,
  MockMenu,
  MockOrder,
  MockPermission,
  MockRole,
  MockSession,
  MockTokenPayload,
  MockUser,
} from './db';
import { db as defaultDb } from './db';

/** 统一响应信封（与 @fw/core ResponseInterceptor 一致） */
interface Envelope<T> {
  code: number;
  message: string;
  data: T;
  traceId: string;
}

/** 业务错误码（docs/40-api-spec.md §2） */
const CODE = {
  OK: 0,
  BAD_REQUEST: 1001,
  NOT_FOUND: 1002,
  CONFLICT: 1003,
  STATE_NOT_ALLOWED: 1004,
  UNAUTHORIZED: 3001,
  FORBIDDEN: 3002,
  TOKEN_EXPIRED: 3003,
  ACCOUNT_LOCKED: 3004,
  INTERNAL: 9001,
  RATE_LIMITED: 9003,
} as const;

/** HTTP 状态码映射 */
const HTTP_STATUS: Record<number, number> = {
  [CODE.OK]: 200,
  [CODE.BAD_REQUEST]: 400,
  [CODE.NOT_FOUND]: 404,
  [CODE.CONFLICT]: 409,
  [CODE.STATE_NOT_ALLOWED]: 400,
  [CODE.UNAUTHORIZED]: 401,
  [CODE.FORBIDDEN]: 403,
  [CODE.TOKEN_EXPIRED]: 401,
  [CODE.ACCOUNT_LOCKED]: 403,
  [CODE.INTERNAL]: 500,
  [CODE.RATE_LIMITED]: 429,
};

/** 请求上下文：鉴权解析后的用户视图 */
interface AuthContext {
  user: MockUser;
  payload: MockTokenPayload;
  roles: MockRole[];
}

/** 处理器返回：handled=true 时已响应 */
interface HandleResult {
  handled: boolean;
}

/** mock JWT：base64url 三段式，签名段固定（无验签，仅前端链路用） */
function b64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signToken(payload: MockTokenPayload): string {
  return `${b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64urlEncode(JSON.stringify(payload))}.mock-signature`;
}

function decodeToken(token: string): MockTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1] as string)) as MockTokenPayload;
  } catch {
    return null;
  }
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 生成 traceId（响应头与日志一致） */
function newTraceId(): string {
  return `mock-${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 取用户权限码（角色并集） */
function userPermissionCodes(database: MockDb, user: MockUser): string[] {
  const ids = new Set<string>();
  for (const role of database.roles) {
    if (user.roleIds.includes(role.id)) {
      for (const pid of role.permissionIds) ids.add(pid);
    }
  }
  const codes: string[] = [];
  for (const pid of ids) {
    const perm = database.permissions.find((p) => p.id === pid);
    if (perm) codes.push(perm.code);
  }
  return codes;
}

/** 解析 Authorization 头；令牌缺失 / 无效 / 过期分别对应 3001 / 3003 */
function authenticate(database: MockDb, req: IncomingMessage): { ok: true; ctx: AuthContext } | { ok: false; code: number; message: string } {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return { ok: false, code: CODE.UNAUTHORIZED, message: '未登录或令牌无效' };
  const payload = decodeToken(token);
  if (!payload || payload.type !== 'access') return { ok: false, code: CODE.UNAUTHORIZED, message: '未登录或令牌无效' };
  if (payload.exp <= nowSeconds()) return { ok: false, code: CODE.TOKEN_EXPIRED, message: '令牌已过期' };
  const user = database.users.find((u) => u.id === payload.sub);
  if (!user) return { ok: false, code: CODE.UNAUTHORIZED, message: '未登录或令牌无效' };
  if (user.status !== 1) return { ok: false, code: CODE.ACCOUNT_LOCKED, message: '账号已禁用' };
  const roles = database.roles.filter((r) => user.roleIds.includes(r.id));
  return { ok: true, ctx: { user, payload, roles } };
}

/** 权限点校验：不满足返回 3002 */
function requirePermission(database: MockDb, ctx: AuthContext, code: string): { ok: true } | { ok: false; code: number; message: string } {
  const codes = userPermissionCodes(database, ctx.user);
  if (!codes.includes(code)) return { ok: false, code: CODE.FORBIDDEN, message: '无操作权限' };
  return { ok: true };
}

/** 读 JSON 请求体 */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** 响应信封 */
function send<T>(res: ServerResponse, code: number, message: string, data: T, traceId: string): void {
  const status = HTTP_STATUS[code] ?? 500;
  const body: Envelope<T> = { code, message, data, traceId };
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Trace-Id', traceId);
  res.end(JSON.stringify(body));
}

/** 菜单树（嵌套结构，按 sort 排序） */
function menuTree(database: MockDb, filter?: (menu: MockMenu) => boolean): MockMenu[] {
  const nodes = database.menus.filter((m) => filter === undefined || filter(m));
  const byId = new Map(nodes.map((m) => [m.id, { ...m, children: [] as MockMenu[] }]));
  const roots: MockMenu[] = [];
  for (const node of byId.values()) {
    const parent = byId.get(node.parentId);
    if (parent && parent !== node) {
      (parent.children as MockMenu[]).push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (list: MockMenu[]): void => {
    list.sort((a, b) => a.sort - b.sort);
    for (const item of list) sortRec(item.children);
  };
  sortRec(roots);
  return roots;
}

/** 去掉 children 的扁平菜单（管理页表格用） */
function flatMenus(database: MockDb): Omit<MockMenu, 'children'>[] {
  return database.menus
    .map(({ children: _children, ...rest }) => rest)
    .sort((a, b) => a.sort - b.sort);
}

/** 登录：账号密码 → 双 token + 用户（失败计数与锁定略，mock 以 3001 提示） */
function handleLogin(database: MockDb, body: Record<string, unknown>, res: ServerResponse, traceId: string): void {
  const account = typeof body.account === 'string' ? body.account : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = database.users.find((u) => u.username === account);
  if (!user || database.passwords[user.username] !== password) {
    send(res, CODE.UNAUTHORIZED, '用户名或密码错误', null, traceId);
    return;
  }
  if (user.status !== 1) {
    send(res, CODE.ACCOUNT_LOCKED, '账号已禁用，请联系管理员', null, traceId);
    return;
  }
  const roles = database.roles.filter((r) => user.roleIds.includes(r.id)).map((r) => r.code);
  const permissions = userPermissionCodes(database, user);
  const jti = randomId('jti');
  const fam = randomId('fam');
  const sessionId = randomId('sess');
  const refreshToken = signToken({
    sub: user.id,
    username: user.username,
    type: 'refresh',
    jti: randomId('jti'),
    fam,
    roles,
    permissions,
    iat: nowSeconds(),
    exp: nowSeconds() + 7 * 24 * 3600,
  });
  database.sessions.push({
    id: sessionId,
    userId: user.id,
    familyId: fam,
    device: 'Chrome · Windows',
    ip: '127.0.0.1',
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    current: false,
  });
  database.refreshTokens[refreshToken] = sessionId;
  user.lastLoginAt = new Date().toISOString();
  user.lastLoginIp = '127.0.0.1';
  send(
    res,
    CODE.OK,
    'ok',
    {
      tokenType: 'Bearer',
      accessToken: signToken({ sub: user.id, username: user.username, type: 'access', jti, fam, roles, permissions, iat: nowSeconds(), exp: nowSeconds() + 2 * 3600 }),
      refreshToken,
      expiresIn: 2 * 3600,
      user: {
        id: user.id,
        username: user.username,
        roles,
        permissions,
        dataScope: roles.includes('admin') ? 'all' : 'self',
        via: 'jwt',
        jti,
        fam,
        exp: nowSeconds() + 2 * 3600,
      },
    },
    traceId,
  );
}

/** 刷新：轮换 refresh，旧 token 立即失效；复用旧 token 判定泄漏并撤销整族 */
function handleRefresh(database: MockDb, body: Record<string, unknown>, res: ServerResponse, traceId: string): void {
  const oldToken = typeof body.refreshToken === 'string' ? body.refreshToken : '';
  const payload = decodeToken(oldToken);
  if (!payload || payload.type !== 'refresh') {
    send(res, CODE.UNAUTHORIZED, '未登录或令牌无效', null, traceId);
    return;
  }
  if (database.usedRefreshTokens.has(oldToken)) {
    // 泄漏判定：撤销该族全部会话
    const session = database.sessions.find((s) => s.familyId === payload.fam);
    if (session) {
      for (const [token, sid] of Object.entries(database.refreshTokens)) {
        const s = database.sessions.find((x) => x.id === sid);
        if (s && s.familyId === payload.fam) delete database.refreshTokens[token];
      }
    }
    send(res, CODE.UNAUTHORIZED, '登录状态已失效，请重新登录', null, traceId);
    return;
  }
  const sessionId = database.refreshTokens[oldToken];
  const session = database.sessions.find((s) => s.id === sessionId);
  const user = database.users.find((u) => u.id === payload.sub);
  if (!session || !user || user.status !== 1) {
    send(res, CODE.UNAUTHORIZED, '未登录或令牌无效', null, traceId);
    return;
  }
  const roles = database.roles.filter((r) => user.roleIds.includes(r.id)).map((r) => r.code);
  const permissions = userPermissionCodes(database, user);
  delete database.refreshTokens[oldToken];
  database.usedRefreshTokens.add(oldToken);
  const newToken = signToken({
    sub: user.id,
    username: user.username,
    type: 'refresh',
    jti: randomId('jti'),
    fam: session.familyId,
    roles,
    permissions,
    iat: nowSeconds(),
    exp: nowSeconds() + 7 * 24 * 3600,
  });
  database.refreshTokens[newToken] = session.id;
  session.lastSeenAt = new Date().toISOString();
  send(
    res,
    CODE.OK,
    'ok',
    {
      tokenType: 'Bearer',
      accessToken: signToken({ sub: user.id, username: user.username, type: 'access', jti: randomId('jti'), fam: session.familyId, roles, permissions, iat: nowSeconds(), exp: nowSeconds() + 2 * 3600 }),
      refreshToken: newToken,
      expiresIn: 2 * 3600,
      user: {
        id: user.id,
        username: user.username,
        roles,
        permissions,
        dataScope: roles.includes('admin') ? 'all' : 'self',
        via: 'jwt',
      },
    },
    traceId,
  );
}

/** 登出：撤销当前设备 refresh 族 */
function handleLogout(database: MockDb, ctx: AuthContext, res: ServerResponse, traceId: string): void {
  const fam = ctx.payload.fam;
  for (const [token, sid] of Object.entries(database.refreshTokens)) {
    const s = database.sessions.find((x) => x.id === sid);
    if (s && s.userId === ctx.user.id && s.familyId === fam) delete database.refreshTokens[token];
  }
  database.sessions = database.sessions.filter((s) => !(s.userId === ctx.user.id && s.familyId === fam));
  send(res, CODE.OK, 'ok', { id: ctx.user.id }, traceId);
}

/** 分页工具 */
function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; total: number; page: number; pageSize: number; hasMore: boolean } {
  const total = items.length;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total, page, pageSize, hasMore: start + pageSize < total };
}

/** 主处理器：返回 handled=false 时由中间件调用 next() 放行 */
export async function handleMockRequest(
  req: IncomingMessage,
  res: ServerResponse,
  database: MockDb = defaultDb,
): Promise<HandleResult> {
  const traceId = newTraceId();
  const url = new URL(req.url ?? '/', 'http://mock.local');
  const path = url.pathname.replace(/^\/api\/v1/, '') || '/';
  const method = (req.method ?? 'GET').toUpperCase();
  const query = url.searchParams;
  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);

  // ---- 公开端点 ----
  if (path === '/auth/login' && method === 'POST') {
    handleLogin(database, body, res, traceId);
    return { handled: true };
  }
  if (path === '/auth/refresh' && method === 'POST') {
    handleRefresh(database, body, res, traceId);
    return { handled: true };
  }

  // ---- 以下均需登录 ----
  const auth = authenticate(database, req);
  if (!auth.ok) {
    send(res, auth.code, auth.message, null, traceId);
    return { handled: true };
  }
  const ctx = auth.ctx;

  // ---- 认证域 ----
  if (path === '/auth/me' && method === 'GET') {
    send(
      res,
      CODE.OK,
      'ok',
      {
        id: ctx.user.id,
        username: ctx.user.username,
        nickname: ctx.user.nickname,
        avatar: ctx.user.avatar,
        roles: ctx.roles.map((r) => r.code),
        permissions: userPermissionCodes(database, ctx.user),
        dataScope: ctx.roles.some((r) => r.dataScope === 'all') ? 'all' : 'self',
      },
      traceId,
    );
    return { handled: true };
  }
  if (path === '/auth/menus' && method === 'GET') {
    const codes = userPermissionCodes(database, ctx.user);
    const tree = menuTree(database, (m) => m.visible && (m.permissionCode === null || codes.includes(m.permissionCode)));
    send(res, CODE.OK, 'ok', tree, traceId);
    return { handled: true };
  }
  if (path === '/auth/logout' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'auth:logout');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    handleLogout(database, ctx, res, traceId);
    return { handled: true };
  }
  if (path === '/auth/change-password' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'auth:change-password');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (database.passwords[ctx.user.username] !== oldPassword) {
      send(res, CODE.BAD_REQUEST, '原密码不正确', null, traceId);
      return { handled: true };
    }
    if (newPassword.length < 8) {
      send(res, CODE.BAD_REQUEST, '新密码长度至少 8 位', null, traceId);
      return { handled: true };
    }
    database.passwords[ctx.user.username] = newPassword;
    database.auditLogs.push({
      id: randomId('a'),
      userId: ctx.user.id,
      module: 'auth',
      action: 'update',
      targetType: 'user',
      targetId: ctx.user.id,
      beforeValue: null,
      afterValue: { changed: 'password' },
      ip: '127.0.0.1',
      userAgent: 'mock',
      traceId,
      createdAt: new Date().toISOString(),
    });
    send(res, CODE.OK, 'ok', { changed: true }, traceId);
    return { handled: true };
  }
  // 登录设备（M5 新增建议接口，待 L2 确认，见 C-06 契约变更记录）
  if (path === '/auth/sessions' && method === 'GET') {
    const sessions: MockSession[] = database.sessions
      .filter((s) => s.userId === ctx.user.id)
      .map((s) => ({ ...s, current: s.familyId === ctx.payload.fam }));
    send(res, CODE.OK, 'ok', sessions, traceId);
    return { handled: true };
  }
  if (path.startsWith('/auth/sessions/') && method === 'DELETE') {
    const sessionId = path.slice('/auth/sessions/'.length);
    const session = database.sessions.find((s) => s.id === sessionId && s.userId === ctx.user.id);
    if (!session) {
      send(res, CODE.NOT_FOUND, '会话不存在', null, traceId);
      return { handled: true };
    }
    for (const [token, sid] of Object.entries(database.refreshTokens)) {
      if (sid === sessionId) delete database.refreshTokens[token];
    }
    database.sessions = database.sessions.filter((s) => s.id !== sessionId);
    send(res, CODE.OK, 'ok', { revoked: sessionId }, traceId);
    return { handled: true };
  }

  // ---- 用户域 ----
  if (path === '/users' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'user:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const selfOnly = !ctx.roles.some((r) => r.dataScope === 'all');
    const page = Math.max(1, Number(query.get('page') ?? '1'));
    const pageSize = Math.min(200, Math.max(1, Number(query.get('pageSize') ?? '20')));
    let items = selfOnly ? database.users.filter((u) => u.id === ctx.user.id) : [...database.users];
    const keyword = query.get('keyword');
    if (keyword) {
      items = items.filter((u) => u.username.includes(keyword) || (u.nickname ?? '').includes(keyword) || (u.email ?? '').includes(keyword));
    }
    const status = query.get('status');
    if (status !== null && status !== '') items = items.filter((u) => String(u.status) === status);
    const roleId = query.get('role_id');
    if (roleId) items = items.filter((u) => u.roleIds.includes(roleId));
    const result = paginate(items, page, pageSize);
    send(res, CODE.OK, 'ok', { ...result, items: result.items.map(stripUser) }, traceId);
    return { handled: true };
  }
  if (path === '/users' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'user:create');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!username || database.users.some((u) => u.username === username)) {
      send(res, CODE.CONFLICT, '用户名已存在', null, traceId);
      return { handled: true };
    }
    const user: MockUser = {
      id: randomId('u'),
      username,
      nickname: typeof body.nickname === 'string' ? body.nickname : null,
      phone: typeof body.phone === 'string' ? body.phone : null,
      email: typeof body.email === 'string' ? body.email : null,
      avatar: null,
      status: body.status === 0 ? 0 : 1,
      roleIds: Array.isArray(body.roleIds) ? (body.roleIds as string[]) : [],
      lastLoginAt: null,
      lastLoginIp: null,
      createdAt: new Date().toISOString(),
    };
    database.users.push(user);
    if (typeof body.password === 'string') database.passwords[user.username] = body.password;
    database.auditLogs.push({
      id: randomId('a'),
      userId: ctx.user.id,
      module: 'user',
      action: 'create',
      targetType: 'user',
      targetId: user.id,
      beforeValue: null,
      afterValue: stripUser(user),
      ip: '127.0.0.1',
      userAgent: 'mock',
      traceId,
      createdAt: new Date().toISOString(),
    });
    send(res, CODE.OK, 'ok', stripUser(user), traceId);
    return { handled: true };
  }
  const userMatch = /^\/users\/([\w-]+)(?:\/(roles|status|reset-password))?$/.exec(path);
  if (userMatch) {
    const userId = userMatch[1] as string;
    const action = userMatch[2];
    const user = database.users.find((u) => u.id === userId);
    if (!user) {
      send(res, CODE.NOT_FOUND, '用户不存在', null, traceId);
      return { handled: true };
    }
    if (action === 'roles' && method === 'PUT') {
      const perm = requirePermission(database, ctx, 'user:assign-role');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const roleIds = Array.isArray(body.roleIds) ? (body.roleIds as string[]) : null;
      if (!roleIds) {
        send(res, CODE.BAD_REQUEST, 'roleIds 必填（字符串数组）', null, traceId);
        return { handled: true };
      }
      user.roleIds = roleIds;
      send(res, CODE.OK, 'ok', stripUser(user), traceId);
      return { handled: true };
    }
    if (action === 'status' && method === 'PUT') {
      const perm = requirePermission(database, ctx, 'user:update');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const status = body.status;
      if (status !== 0 && status !== 1) {
        send(res, CODE.BAD_REQUEST, 'status 只能为 0（禁用）或 1（启用）', null, traceId);
        return { handled: true };
      }
      const before = user.status;
      user.status = status;
      if (status === 0) {
        for (const [token, sid] of Object.entries(database.refreshTokens)) {
          const s = database.sessions.find((x) => x.id === sid);
          if (s && s.userId === user.id) delete database.refreshTokens[token];
        }
        database.sessions = database.sessions.filter((s) => s.userId !== user.id);
      }
      database.auditLogs.push({
        id: randomId('a'),
        userId: ctx.user.id,
        module: 'user',
        action: 'update',
        targetType: 'user',
        targetId: user.id,
        beforeValue: { status: before },
        afterValue: { status },
        ip: '127.0.0.1',
        userAgent: 'mock',
        traceId,
        createdAt: new Date().toISOString(),
      });
      send(res, CODE.OK, 'ok', { id: user.id, status: user.status, forcedLogout: status === 0 }, traceId);
      return { handled: true };
    }
    if (action === 'reset-password' && method === 'POST') {
      const perm = requirePermission(database, ctx, 'user:reset-password');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const oneTime = 'Reset@123456';
      database.passwords[user.username] = oneTime;
      send(res, CODE.OK, 'ok', { id: user.id, oneTimePassword: oneTime }, traceId);
      return { handled: true };
    }
    if (!action && method === 'GET') {
      const perm = requirePermission(database, ctx, 'user:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      send(res, CODE.OK, 'ok', stripUser(user), traceId);
      return { handled: true };
    }
    if (!action && method === 'PUT') {
      const perm = requirePermission(database, ctx, 'user:update');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const before = stripUser(user);
      if (typeof body.nickname === 'string') user.nickname = body.nickname;
      if (typeof body.phone === 'string') user.phone = body.phone;
      if (typeof body.email === 'string') user.email = body.email;
      if (body.status === 0 || body.status === 1) user.status = body.status;
      if (Array.isArray(body.roleIds)) user.roleIds = body.roleIds as string[];
      database.auditLogs.push({
        id: randomId('a'),
        userId: ctx.user.id,
        module: 'user',
        action: 'update',
        targetType: 'user',
        targetId: user.id,
        beforeValue: before,
        afterValue: stripUser(user),
        ip: '127.0.0.1',
        userAgent: 'mock',
        traceId,
        createdAt: new Date().toISOString(),
      });
      send(res, CODE.OK, 'ok', stripUser(user), traceId);
      return { handled: true };
    }
    if (!action && method === 'DELETE') {
      const perm = requirePermission(database, ctx, 'user:delete');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      if (user.id === 'u-admin') {
        send(res, CODE.STATE_NOT_ALLOWED, '内置管理员不允许删除', null, traceId);
        return { handled: true };
      }
      database.users = database.users.filter((u) => u.id !== user.id);
      database.auditLogs.push({
        id: randomId('a'),
        userId: ctx.user.id,
        module: 'user',
        action: 'delete',
        targetType: 'user',
        targetId: user.id,
        beforeValue: stripUser(user),
        afterValue: null,
        ip: '127.0.0.1',
        userAgent: 'mock',
        traceId,
        createdAt: new Date().toISOString(),
      });
      send(res, CODE.OK, 'ok', { id: user.id }, traceId);
      return { handled: true };
    }
  }

  // ---- 角色域 ----
  if (path === '/roles' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'role:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    send(res, CODE.OK, 'ok', database.roles.map(stripRole), traceId);
    return { handled: true };
  }
  if (path === '/roles' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'role:create');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code || database.roles.some((r) => r.code === code)) {
      send(res, CODE.CONFLICT, '角色编码已存在', null, traceId);
      return { handled: true };
    }
    const role: MockRole = {
      id: randomId('r'),
      code,
      name: typeof body.name === 'string' ? body.name : code,
      remark: typeof body.remark === 'string' ? body.remark : null,
      isSystem: false,
      dataScope: (['all', 'org_below', 'org', 'self'] as const).includes(body.dataScope as MockRole['dataScope']) ? (body.dataScope as MockRole['dataScope']) : 'self',
      sort: database.roles.length + 1,
      permissionIds: Array.isArray(body.permissionIds) ? (body.permissionIds as string[]) : [],
    };
    database.roles.push(role);
    send(res, CODE.OK, 'ok', stripRole(role), traceId);
    return { handled: true };
  }
  const roleMatch = /^\/roles\/([\w-]+)(?:\/(permissions|copy))?$/.exec(path);
  if (roleMatch) {
    const roleId = roleMatch[1] as string;
    const action = roleMatch[2];
    const role = database.roles.find((r) => r.id === roleId);
    if (!role) {
      send(res, CODE.NOT_FOUND, '角色不存在', null, traceId);
      return { handled: true };
    }
    if (action === 'permissions' && method === 'GET') {
      const perm = requirePermission(database, ctx, 'role:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const granted = database.permissions.filter((p) => role.permissionIds.includes(p.id));
      send(res, CODE.OK, 'ok', { roleId, permissions: granted }, traceId);
      return { handled: true };
    }
    if (action === 'permissions' && method === 'PUT') {
      const perm = requirePermission(database, ctx, 'role:grant');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      if (role.code === 'admin') {
        send(res, CODE.STATE_NOT_ALLOWED, '内置管理员角色不允许调整权限（保证系统可管理）', null, traceId);
        return { handled: true };
      }
      const permissionIds = Array.isArray(body.permissionIds) ? (body.permissionIds as string[]) : null;
      if (!permissionIds) {
        send(res, CODE.BAD_REQUEST, 'permissionIds 必填（字符串数组）', null, traceId);
        return { handled: true };
      }
      role.permissionIds = permissionIds;
      send(res, CODE.OK, 'ok', { roleId, count: permissionIds.length }, traceId);
      return { handled: true };
    }
    if (action === 'copy' && method === 'POST') {
      const perm = requirePermission(database, ctx, 'role:create');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const copy: MockRole = {
        ...role,
        id: randomId('r'),
        code: `${role.code}-copy-${Math.random().toString(36).slice(2, 6)}`,
        name: `${role.name} 副本`,
        isSystem: false,
        permissionIds: [...role.permissionIds],
      };
      database.roles.push(copy);
      send(res, CODE.OK, 'ok', stripRole(copy), traceId);
      return { handled: true };
    }
    if (!action && method === 'PUT') {
      const perm = requirePermission(database, ctx, 'role:update');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      if (typeof body.name === 'string') role.name = body.name;
      if (typeof body.remark === 'string') role.remark = body.remark;
      if ((['all', 'org_below', 'org', 'self'] as const).includes(body.dataScope as MockRole['dataScope'])) {
        role.dataScope = body.dataScope as MockRole['dataScope'];
      }
      send(res, CODE.OK, 'ok', stripRole(role), traceId);
      return { handled: true };
    }
    if (!action && method === 'DELETE') {
      const perm = requirePermission(database, ctx, 'role:delete');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      if (role.isSystem) {
        send(res, CODE.STATE_NOT_ALLOWED, '内置角色不允许删除', null, traceId);
        return { handled: true };
      }
      database.roles = database.roles.filter((r) => r.id !== role.id);
      for (const u of database.users) u.roleIds = u.roleIds.filter((id) => id !== role.id);
      send(res, CODE.OK, 'ok', { id: role.id }, traceId);
      return { handled: true };
    }
  }

  // ---- 权限点 ----
  if (path === '/permissions' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'permission:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const groups = new Map<string, MockPermission[]>();
    for (const permission of database.permissions) {
      const bucket = groups.get(permission.module) ?? [];
      bucket.push(permission);
      groups.set(permission.module, bucket);
    }
    send(res, CODE.OK, 'ok', [...groups.entries()].map(([module, items]) => ({ module, items })), traceId);
    return { handled: true };
  }

  // ---- 菜单域 ----
  if (path === '/menus/tree' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'menu:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    send(res, CODE.OK, 'ok', flatMenus(database), traceId);
    return { handled: true };
  }
  if (path === '/menus' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'menu:create');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      send(res, CODE.BAD_REQUEST, '菜单名称必填', null, traceId);
      return { handled: true };
    }
    const menu: MockMenu = {
      id: randomId('m'),
      parentId: typeof body.parentId === 'string' ? body.parentId : '0',
      name,
      path: typeof body.path === 'string' ? body.path : null,
      component: typeof body.component === 'string' ? body.component : null,
      icon: typeof body.icon === 'string' ? body.icon : null,
      permissionCode: typeof body.permissionCode === 'string' ? body.permissionCode : null,
      visible: body.visible === false ? false : true,
      sort: typeof body.sort === 'number' ? body.sort : database.menus.length + 1,
    };
    database.menus.push(menu);
    send(res, CODE.OK, 'ok', stripMenu(menu), traceId);
    return { handled: true };
  }
  const menuMatch = /^\/menus\/([\w-]+)$/.exec(path);
  if (menuMatch) {
    const menu = database.menus.find((m) => m.id === menuMatch[1]);
    if (!menu) {
      send(res, CODE.NOT_FOUND, '菜单不存在', null, traceId);
      return { handled: true };
    }
    if (method === 'PUT') {
      const perm = requirePermission(database, ctx, 'menu:update');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      if (typeof body.name === 'string') menu.name = body.name;
      if (typeof body.path === 'string') menu.path = body.path;
      if (typeof body.component === 'string') menu.component = body.component;
      if (typeof body.icon === 'string') menu.icon = body.icon;
      if (typeof body.permissionCode === 'string') menu.permissionCode = body.permissionCode;
      if (typeof body.visible === 'boolean') menu.visible = body.visible;
      if (typeof body.sort === 'number') menu.sort = body.sort;
      if (typeof body.parentId === 'string') menu.parentId = body.parentId;
      send(res, CODE.OK, 'ok', stripMenu(menu), traceId);
      return { handled: true };
    }
    if (method === 'DELETE') {
      const perm = requirePermission(database, ctx, 'menu:delete');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      if (database.menus.some((m) => m.parentId === menu.id)) {
        send(res, CODE.STATE_NOT_ALLOWED, '存在子菜单，禁止删除', null, traceId);
        return { handled: true };
      }
      database.menus = database.menus.filter((m) => m.id !== menu.id);
      send(res, CODE.OK, 'ok', { id: menu.id }, traceId);
      return { handled: true };
    }
  }

  // ---- 字典域 ----
  if (path === '/dict/categories' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'dict:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    send(res, CODE.OK, 'ok', database.dictCategories, traceId);
    return { handled: true };
  }
  if (path === '/dict/categories' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'dict:create');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code || database.dictCategories.some((c) => c.code === code)) {
      send(res, CODE.CONFLICT, '字典编码已存在', null, traceId);
      return { handled: true };
    }
    const category: MockDictCategory = { id: randomId('dc'), code, name: typeof body.name === 'string' ? body.name : code, remark: null };
    database.dictCategories.push(category);
    send(res, CODE.OK, 'ok', category, traceId);
    return { handled: true };
  }
  const categoryMatch = /^\/dict\/categories\/([\w-]+)$/.exec(path);
  if (categoryMatch && (method === 'PUT' || method === 'DELETE')) {
    const category = database.dictCategories.find((c) => c.id === categoryMatch[1]);
    if (!category) {
      send(res, CODE.NOT_FOUND, '字典分类不存在', null, traceId);
      return { handled: true };
    }
    if (method === 'PUT') {
      const perm = requirePermission(database, ctx, 'dict:update');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      if (typeof body.name === 'string') category.name = body.name;
      if (typeof body.remark === 'string') category.remark = body.remark;
      send(res, CODE.OK, 'ok', category, traceId);
      return { handled: true };
    }
    const perm = requirePermission(database, ctx, 'dict:delete');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    database.dictCategories = database.dictCategories.filter((c) => c.id !== category.id);
    database.dictItems = database.dictItems.filter((i) => i.categoryId !== category.id);
    send(res, CODE.OK, 'ok', { id: category.id }, traceId);
    return { handled: true };
  }
  if (path === '/dict/items' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'dict:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const categoryId = query.get('category_id') ?? '';
    const items = database.dictItems.filter((i) => i.categoryId === categoryId).sort((a, b) => a.sort - b.sort);
    send(res, CODE.OK, 'ok', items, traceId);
    return { handled: true };
  }
  if (path === '/dict/items' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'dict:create');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const item: MockDictItem = {
      id: randomId('di'),
      categoryId: typeof body.categoryId === 'string' ? body.categoryId : '',
      label: typeof body.label === 'string' ? body.label : '',
      value: typeof body.value === 'string' ? body.value : '',
      color: typeof body.color === 'string' ? body.color : null,
      sort: typeof body.sort === 'number' ? body.sort : 99,
    };
    database.dictItems.push(item);
    send(res, CODE.OK, 'ok', item, traceId);
    return { handled: true };
  }
  const itemMatch = /^\/dict\/items\/([\w-]+)$/.exec(path);
  if (itemMatch && (method === 'PUT' || method === 'DELETE')) {
    const item = database.dictItems.find((i) => i.id === itemMatch[1]);
    if (!item) {
      send(res, CODE.NOT_FOUND, '字典项不存在', null, traceId);
      return { handled: true };
    }
    if (method === 'PUT') {
      const perm = requirePermission(database, ctx, 'dict:update');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      if (typeof body.label === 'string') item.label = body.label;
      if (typeof body.value === 'string') item.value = body.value;
      if (typeof body.color === 'string') item.color = body.color;
      if (typeof body.sort === 'number') item.sort = body.sort;
      send(res, CODE.OK, 'ok', item, traceId);
      return { handled: true };
    }
    const perm = requirePermission(database, ctx, 'dict:delete');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    database.dictItems = database.dictItems.filter((i) => i.id !== item.id);
    send(res, CODE.OK, 'ok', { id: item.id }, traceId);
    return { handled: true };
  }
  // GET /dict/:code —— 登录后可用，供 useDict 消费
  const dictCodeMatch = /^\/dict\/([\w-]+)$/.exec(path);
  if (dictCodeMatch && method === 'GET') {
    const category = database.dictCategories.find((c) => c.code === dictCodeMatch[1]);
    if (!category) {
      send(res, CODE.NOT_FOUND, '字典分类不存在', null, traceId);
      return { handled: true };
    }
    const items = database.dictItems.filter((i) => i.categoryId === category.id).sort((a, b) => a.sort - b.sort);
    send(res, CODE.OK, 'ok', items, traceId);
    return { handled: true };
  }

  // ---- 审计域 ----
  if (path === '/audit-logs' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'audit:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const page = Math.max(1, Number(query.get('page') ?? '1'));
    const pageSize = Math.min(200, Math.max(1, Number(query.get('pageSize') ?? '20')));
    let items = [...database.auditLogs];
    const userId = query.get('user_id');
    if (userId) items = items.filter((a) => a.userId === userId);
    const module = query.get('module');
    if (module) items = items.filter((a) => a.module === module);
    const action = query.get('action');
    if (action) items = items.filter((a) => a.action === action);
    const from = query.get('from');
    if (from) items = items.filter((a) => a.createdAt >= from);
    const to = query.get('to');
    if (to) items = items.filter((a) => a.createdAt <= to);
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    send(res, CODE.OK, 'ok', paginate(items, page, pageSize), traceId);
    return { handled: true };
  }
  const auditMatch = /^\/audit-logs\/([\w-]+)$/.exec(path);
  if (auditMatch && method === 'GET') {
    const perm = requirePermission(database, ctx, 'audit:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const log = database.auditLogs.find((a) => a.id === auditMatch[1]);
    if (!log) {
      send(res, CODE.NOT_FOUND, '审计记录不存在', null, traceId);
      return { handled: true };
    }
    send(res, CODE.OK, 'ok', log, traceId);
    return { handled: true };
  }

  // ---- 演示订单域（生成器产出页面的 mock 数据源） ----
  if (path === '/orders' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'order:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const page = Math.max(1, Number(query.get('page') ?? '1'));
    const pageSize = Math.min(200, Math.max(1, Number(query.get('pageSize') ?? '20')));
    let items = [...database.orders];
    const keyword = query.get('keyword');
    if (keyword) items = items.filter((o) => o.orderNo.includes(keyword) || o.customer.includes(keyword));
    const status = query.get('status');
    if (status !== null && status !== '') items = items.filter((o) => String(o.status) === status);
    send(res, CODE.OK, 'ok', paginate(items, page, pageSize), traceId);
    return { handled: true };
  }
  if (path === '/orders' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'order:create');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const order: MockOrder = {
      id: randomId('o'),
      orderNo: typeof body.orderNo === 'string' ? body.orderNo : `NO${Date.now()}`,
      customer: typeof body.customer === 'string' ? body.customer : '',
      amount: typeof body.amount === 'string' ? body.amount : '0.00',
      status: body.status === 0 ? 0 : 1,
      channel: typeof body.channel === 'string' ? body.channel : 'web',
      createdAt: new Date().toISOString(),
    };
    database.orders.unshift(order);
    send(res, CODE.OK, 'ok', order, traceId);
    return { handled: true };
  }
  const orderMatch = /^\/orders\/([\w-]+)$/.exec(path);
  if (orderMatch) {
    const order = database.orders.find((o) => o.id === orderMatch[1]);
    if (!order) {
      send(res, CODE.NOT_FOUND, '订单不存在', null, traceId);
      return { handled: true };
    }
    if (method === 'GET') {
      const perm = requirePermission(database, ctx, 'order:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      send(res, CODE.OK, 'ok', order, traceId);
      return { handled: true };
    }
    if (method === 'PUT') {
      const perm = requirePermission(database, ctx, 'order:update');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      if (typeof body.customer === 'string') order.customer = body.customer;
      if (typeof body.amount === 'string') order.amount = body.amount;
      if (typeof body.channel === 'string') order.channel = body.channel;
      if (body.status === 0 || body.status === 1) order.status = body.status;
      send(res, CODE.OK, 'ok', order, traceId);
      return { handled: true };
    }
    if (method === 'DELETE') {
      const perm = requirePermission(database, ctx, 'order:delete');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      database.orders = database.orders.filter((o) => o.id !== order.id);
      send(res, CODE.OK, 'ok', { id: order.id }, traceId);
      return { handled: true };
    }
  }

  // 未命中：404
  send(res, CODE.NOT_FOUND, `接口不存在：${method} ${path}`, null, traceId);
  return { handled: true };
}

/** 用户输出脱敏（mock 不返回口令相关字段） */
function stripUser(user: MockUser): Omit<MockUser, never> {
  return { ...user };
}

/** 角色输出（去掉内部权限 id 列表，对外给权限码由 /roles/:id/permissions 提供） */
function stripRole(role: MockRole): Omit<MockRole, 'permissionIds'> & { permissionCount: number } {
  const { permissionIds: _permissionIds, ...rest } = role;
  return { ...rest, permissionCount: role.permissionIds.length };
}

/** 菜单输出（管理页表格不需要 children） */
function stripMenu(menu: MockMenu): Omit<MockMenu, 'children'> {
  const { children: _children, ...rest } = menu;
  return rest;
}

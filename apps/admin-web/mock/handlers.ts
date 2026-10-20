/*
 * @file mock 请求处理器（C-06 前端 API 契约的 HTTP 实现）
 * @description 以 connect 中间件形式处理 /api/v1/*：统一响应信封 { code, message, data, traceId }、
 *   错误码表（docs/40-api-spec.md §2）、Bearer JWT 鉴权与权限点校验（未授权 3001 / 过期 3003 / 越权 3002）、
 *   refresh 轮换（复用即失效）。路由表与 API 规格 §3 对齐；分页参数 page/pageSize，软删除语义 DELETE。
 *   设计目标：mock 与真实后端响应结构零差异，切真实 API 只改 VITE_API_BASE_URL。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo M7：新增队列管理端点（/admin/queue/*：状态、指标、处理器、cron 快照与手动触发、
 *   死信列表/重放/清理、暂停恢复、清空等待），查看类校验 system:queue:list、变更类校验 system:queue:manage
 * @modified 2026-10-14 donttemo 契约对齐（C-06）：新增 PUT /auth/profile（本人资料自助，校验 auth:me；
 *   与后端 example-api 同构）；DELETE /auth/sessions/:id 补 auth:revoke-session 权限校验——
 *   此前 mock 放行而真实后端 3002，属「本机过、真机挂」的隐性缺口
 * @modified 2026-10-14 donttemo GET /auth/menus 去掉 visible 过滤，与真实后端行为对齐（后端只按权限码
 *   过滤，可见性由前端 visibleMenus() 剪枝）—— 原 mock 过滤会让前端剪枝在 dev 下永不执行
 * @modified 2026-10-14 donttemo BUG-15：GET /users 支持 `sort`（白名单解析 + 未知字段/非法方向 400 +
 *   默认 createdAt desc + id asc tie-breaker），与 example-api 的 parseSortQuery 同语义 —— mock 若放宽
 *   校验即产生「dev 全绿、真机 400」的假绿
 * @modified 2026-10-15 donttemo N-01/N-02：① 死信列表分页（page/pageSize，上限 200，响应追加
 *   page/pageSize，与 @fw/queue 分页改造同形）；② 租户管理五端点（/tenants CRUD + migrate，
 *   权限 tenant:* + system:tenant:ignore 双重要求，legacy 停用/迁移 1004，dedicated 必填 dbUrl）；
 *   ③ 异步任务面（/jobs/:id/progress|retry|download，虚拟时间线推进进度，归属人隔离，404 不泄露存在性）
 *   与 GET /audit-logs/export 派发（audit:export，产物 CSV 快照）
 * @modified 2026-10-15 donttemo BUG-15 增量 + E-07：/roles、/dict/categories、/dict/items 接入排序
 *   白名单（与 example-api 逐项一致，未知字段 400/1001 不静默忽略）；/dict/audit_module 字典端点
 *   随字典数据落地（GET /dict/:code 通用段直接命中，无需单独 handler）
 * @modified 2026-10-15 donttemo M10 E-12：`POST /events/ticket` 明确返回「mock 不提供 SSE」，
 *   前端据此确定性降级为轮询兜底（不伪造票据）
 * @modified 2026-10-15 donttemo M10 E-13：站内信五端点（`/notifications` 列表/未读数/已读/全部已读/删除，
 *   `notification:read` 守卫 + 归属人 404）+ 权限点与角色授权同步（mock 无事件面，消息为预置数据）
 * @modified 2026-10-15 donttemo M10/E-16：死信分页每页上限提为常量（与 @fw/queue 的
 *   MQ_DEAD_LETTER_PAGE_MAX 默认值同口径）；配置中心白名单补 web.keepAliveMax（12 键）、
 *   已知键集补 E-16 四个新点路径（boot 键 → 5001 判别依据）
 * @modified 2026-10-15 donttemo M10/E-17：新增公开端点 `POST /telemetry/client-errors`
 *   （前端 RUM 错误上报，与 example-api ClientErrorsController 同构：形状 / 来源枚举 /
 *   单批 10 条校验，响应 `{ received, total }`）
 * @modified 2026-10-16 donttemo M10 E-09：附件三端点（`POST /files` multipart 上传 + `file:create`
 *   守卫，`GET /files/:id` 元数据与 `GET /files/:id/download` 登录即可）——类型/大小白名单默认
 *   收紧口径与 @fw/storage 同源（20MB + 扩展名白名单，400 文案逐字一致），下载逐字节回放
 * @module admin-web/mock
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  MockAuditLog,
  MockDb,
  MockDictCategory,
  MockDictItem,
  MockJob,
  MockMenu,
  MockMenuTree,
  MockNotification,
  MockOrder,
  MockPermission,
  MockRole,
  MockSession,
  MockTenant,
  MockTokenPayload,
  MockUploadFile,
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
  // 业务校验失败（PRD-012 OBS-03：与 @fw/core ErrorCode 全集同源，axis G 门禁锁定）
  BUSINESS: 2001,
  UNAUTHORIZED: 3001,
  FORBIDDEN: 3002,
  TOKEN_EXPIRED: 3003,
  ACCOUNT_LOCKED: 3004,
  // M8 租户 / 9002 依赖不可用（PRD-012 OBS-03：与 @fw/core ErrorCode 全集同源，axis G 门禁锁定）
  TENANT_INVALID: 4001,
  // M13 SaaS 运营（PRD-013 / ADR-0030~0031，与 @fw/core ErrorCode 同源，axis G 门禁锁定）
  QUOTA_EXCEEDED: 4029,
  LIFECYCLE_TRANSITION_INVALID: 4030,
  TENANT_SUSPENDED: 4031,
  DEPENDENCY_UNAVAILABLE: 9002,
  INTERNAL: 9001,
  RATE_LIMITED: 9003,
  // M9 配置中心（PRD-009 §6，与 @fw/core ErrorCode 同源）
  CONFIG_NOT_HOT: 5001,
  CONFIG_INVALID_VALUE: 5002,
  CONFIG_NOT_FOUND: 5003,
} as const;

/**
 * 死信分页每页条数上限（M10/E-16：与 @fw/queue 的 MQ_DEAD_LETTER_PAGE_MAX 默认值同口径；
 * mock 无 env 注入面，固定取默认值 200）
 */
const MOCK_DEAD_LETTER_PAGE_MAX = 200;

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
  [CODE.CONFIG_NOT_HOT]: 400,
  [CODE.CONFIG_INVALID_VALUE]: 400,
  [CODE.CONFIG_NOT_FOUND]: 404,
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
function send<T>(res: ServerResponse, code: number, message: string, data: T, traceId: string, details?: Array<{ field: string; message: string }>): void {
  const status = HTTP_STATUS[code] ?? 500;
  // details 与真实后端 GlobalExceptionFilter 同构：放信封顶层（data=null 的错误形态）
  const body: Envelope<T> & { details?: Array<{ field: string; message: string }> } = { code, message, data, traceId };
  if (details) body.details = details;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Trace-Id', traceId);
  res.end(JSON.stringify(body));
}

/** M10 E-09 附件上传上限：与 @fw/storage 默认（STORAGE_MAX_MB=20）同口径（mock 无 env 注入面） */
const MOCK_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** M10 E-09 扩展名白名单：与 @fw/storage 默认（STORAGE_ALLOWED_EXTS）逐项一致 */
const MOCK_UPLOAD_ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.csv', '.xlsx', '.docx', '.zip'];

/** 读原始请求体（multipart 用；JSON 走 readBody；超限断连返回 null 与 readBody 语义一致） */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/** multipart 提取结果（字段名 file 的那一段） */
interface MultipartFilePart {
  fileName: string;
  contentType: string;
  data: Buffer;
}

/**
 * 最小 multipart 解析：只取 name="file" 的段（mock 专用，满足前端 el-upload FormData 形态）。
 * 与真实后端 multer 的差异点（多文件 / 非常规编码）不需要——前端只会发单文件段。
 * boundary 取自 HTTP 头（请求体里只有分隔行，没有 boundary= 声明）。
 */
function extractMultipartFile(raw: Buffer, contentTypeHeader: string | undefined): MultipartFilePart | null {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader ?? '');
  if (!boundaryMatch) return null;
  const boundary = `--${(boundaryMatch[1] ?? boundaryMatch[2]).trim()}`;
  const segments: MultipartFilePart[] = [];
  let cursor = raw.indexOf(boundary);
  while (cursor >= 0) {
    const headStart = cursor + boundary.length;
    if (raw.subarray(headStart, headStart + 2).toString() === '--') break;
    const headEnd = raw.indexOf('\r\n\r\n', headStart);
    if (headEnd < 0) break;
    const next = raw.indexOf(boundary, headEnd + 4);
    if (next < 0) break;
    const head = raw.subarray(headStart, headEnd).toString('utf8');
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? '';
    // 段体去掉结尾 \r\n（boundary 前的 CRLF 属协议分隔符）；非 file 段丢弃
    const data = name === 'file' ? raw.subarray(headEnd + 4, next - 2) : Buffer.alloc(0);
    segments.push({
      fileName: name === 'file' ? (/filename="([^"]*)"/.exec(head)?.[1] ?? '') : '',
      contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? 'application/octet-stream',
      data,
    });
    cursor = next;
  }
  return segments.find((segment) => segment.data.length > 0 || segment.fileName !== '') ?? null;
}

/** 扩展名提取（小写含点；与 @fw/storage extOf 同语义） */
function uploadExtOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/** 菜单树（嵌套结构，按 sort 排序） */
function menuTree(database: MockDb, filter?: (menu: MockMenu) => boolean): MockMenuTree[] {
  const nodes = database.menus.filter((m) => filter === undefined || filter(m));
  const byId = new Map<string, MockMenuTree>();
  for (const menu of nodes) byId.set(menu.id, { ...menu, children: [] });
  const roots: MockMenuTree[] = [];
  for (const node of byId.values()) {
    const parent = byId.get(node.parentId);
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (list: MockMenuTree[]): void => {
    list.sort((a, b) => a.sort - b.sort);
    for (const item of list) sortRec(item.children);
  };
  sortRec(roots);
  return roots;
}

/** 扁平菜单（管理页表格用；mock 菜单本身即扁平存储，按 sort 排序输出） */
function flatMenus(database: MockDb): MockMenu[] {
  return [...database.menus].sort((a, b) => a.sort - b.sort);
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

/**
 * 用户列表排序白名单（BUG-15，与 example-api 的 USER_SORT_FIELDS 逐项一致）
 *
 * mock 必须与真实后端**零差异**：一旦 mock 放宽了这里，就会出现「dev 全绿、真机 400」。
 */
const MOCK_USER_SORT_FIELDS: Record<string, string> = {
  id: 'id',
  username: 'username',
  nickname: 'nickname',
  status: 'status',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  last_login_at: 'lastLoginAt',
};

/** 单次请求允许的最大排序字段数（与后端 SORT_QUERY_MAX_ITEMS 对齐） */
const MOCK_SORT_MAX_ITEMS = 5;

/**
 * 审计日志排序白名单（BUG-15，与 example-api 的 AUDIT_SORT_FIELDS 逐项一致）
 */
const MOCK_AUDIT_SORT_FIELDS: Record<string, string> = {
  id: 'id',
  module: 'module',
  action: 'action',
  target_type: 'targetType',
  created_at: 'createdAt',
};

/**
 * 审计过滤参数白名单（M12 W2 OBS-14，与 example-api 的 AUDIT_FILTER_PARAMS 逐项一致）：
 * 未知过滤参数一律 400 / 1001，不静默忽略
 */
const MOCK_AUDIT_FILTER_PARAMS = [
  'page', 'pageSize', 'user_id', 'module', 'action', 'target_type', 'target_id', 'from', 'to', 'sort',
  'trace_id', 'request_id', 'family_id', 'category', 'event',
  'simulate', // 失败演示路径（与 example-api 的 AUDIT_FILTER_PARAMS 逐项一致）
];

/** 白名单校验：返回首个未知过滤参数的 400 文案；全部合法返回 null（反向验证：不静默忽略） */
function unknownMockAuditFilterParam(query: URLSearchParams): string | null {
  for (const key of [...query.keys()]) {
    if (!MOCK_AUDIT_FILTER_PARAMS.includes(key)) {
      return `未知过滤参数：${key}（允许：${MOCK_AUDIT_FILTER_PARAMS.join(' / ')}）`;
    }
  }
  return null;
}

/** M12 W2 OBS-14：契约字段精确过滤（列表与导出共用） */
function applyMockAuditContractFilters<T extends { traceId?: string | null; requestId?: string | null; familyId?: string | null; category?: string | null; event?: string | null; targetType?: string | null; targetId?: string | null }>(
  rows: T[],
  query: URLSearchParams,
): T[] {
  const targetType = query.get('target_type');
  if (targetType) rows = rows.filter((a) => a.targetType === targetType);
  const targetId = query.get('target_id');
  if (targetId) rows = rows.filter((a) => a.targetId === targetId);
  const traceId = query.get('trace_id');
  if (traceId) rows = rows.filter((a) => a.traceId === traceId);
  const requestId = query.get('request_id');
  if (requestId) rows = rows.filter((a) => a.requestId === requestId);
  const familyId = query.get('family_id');
  if (familyId) rows = rows.filter((a) => a.familyId === familyId);
  const category = query.get('category');
  if (category) rows = rows.filter((a) => a.category === category);
  const event = query.get('event');
  if (event) rows = rows.filter((a) => a.event === event);
  return rows;
}

/**
 * 租户列表排序白名单（N-01，与 example-api 的 TENANT_SORT_FIELDS 逐项一致）
 */
const MOCK_TENANT_SORT_FIELDS: Record<string, string> = {
  id: 'id',
  code: 'code',
  name: 'name',
  isolation: 'isolation',
  status: 'status',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  expire_at: 'expireAt',
};

/**
 * 角色列表排序白名单（BUG-15 增量，与 example-api 的 ROLE_SORT_FIELDS 逐项一致）；
 * permissionCount 为聚合计算字段、createdAt 不在视图内，均不可排序
 */
const MOCK_ROLE_SORT_FIELDS: Record<string, string> = {
  id: 'id',
  code: 'code',
  name: 'name',
  remark: 'remark',
  data_scope: 'dataScope',
  sort: 'sort',
};

/** 字典分类排序白名单（与 example-api 的 DICT_CATEGORY_SORT_FIELDS 逐项一致；视图无 createdAt） */
const MOCK_DICT_CATEGORY_SORT_FIELDS: Record<string, string> = {
  id: 'id',
  code: 'code',
  name: 'name',
  remark: 'remark',
};

/** 字典项排序白名单（与 example-api 的 DICT_ITEM_SORT_FIELDS 逐项一致） */
const MOCK_DICT_ITEM_SORT_FIELDS: Record<string, string> = {
  id: 'id',
  label: 'label',
  value: 'value',
  sort: 'sort',
};

/**
 * 解析 sort 查询参数（BUG-15）——与后端 `parseSortQuery` 同语义：
 * 未知字段 / 非法方向 / 超出上限一律返回 `error`（由调用方回 400/1001），**不静默忽略**。
 * 空串或未传返回空数组（调用方回落默认排序）。
 */
function parseMockSort(
  raw: string | null,
  fields: Record<string, string>,
): { items: Array<[string, 'asc' | 'desc']> } | { error: string } {
  const source = (raw ?? '').trim();
  if (source === '') return { items: [] };
  const segments = source.split(',').map((segment) => segment.trim()).filter((segment) => segment !== '');
  if (segments.length === 0) return { items: [] };
  if (segments.length > MOCK_SORT_MAX_ITEMS) {
    return { error: `sort 字段数超出上限（最多 ${MOCK_SORT_MAX_ITEMS} 个）` };
  }

  const items: Array<[string, 'asc' | 'desc']> = [];
  const seen = new Map<string, number>();
  for (const segment of segments) {
    const separator = segment.indexOf(':');
    const param = (separator === -1 ? segment : segment.slice(0, separator)).trim();
    const rawDirection = (separator === -1 ? '' : segment.slice(separator + 1)).trim();
    if (param === '') return { error: 'sort 字段名不能为空' };
    const field = fields[param];
    if (!field) return { error: `sort 字段不支持：${param}` };
    let direction: 'asc' | 'desc' = 'asc';
    if (rawDirection !== '') {
      const lowered = rawDirection.toLowerCase();
      if (lowered !== 'asc' && lowered !== 'desc') return { error: `sort 方向只能为 asc 或 desc：${param}` };
      direction = lowered;
    }
    const previous = seen.get(field);
    if (previous === undefined) {
      seen.set(field, items.length);
      items.push([field, direction]);
    } else {
      items[previous] = [field, direction];
    }
  }
  return { items };
}

/**
 * 应用排序（BUG-15）：未传排序时回落 `defaultField defaultDirection`；始终追加 `id asc` 作为
 * tie-breaker，保证与后端一样在 `skip/take` 下结果稳定。
 */
function applyMockSort<T extends object>(
  rows: T[],
  entries: Array<[string, 'asc' | 'desc']>,
  defaultField: string,
  defaultDirection: 'asc' | 'desc',
): T[] {
  const effective: Array<[string, 'asc' | 'desc']> = entries.length ? entries : [[defaultField, defaultDirection]];
  const ordered = effective.some(([field]) => field === 'id')
    ? effective
    : [...effective, ['id', 'asc'] as [string, 'asc' | 'desc']];

  return [...rows].sort((a, b) => {
    const left = a as unknown as Record<string, unknown>;
    const right = b as unknown as Record<string, unknown>;
    for (const [field, direction] of ordered) {
      const leftValue = left[field];
      const rightValue = right[field];
      if (leftValue === rightValue) continue;
      let diff: number;
      if (leftValue === null || leftValue === undefined) diff = -1;
      else if (rightValue === null || rightValue === undefined) diff = 1;
      else if (typeof leftValue === 'number' && typeof rightValue === 'number') diff = leftValue - rightValue;
      else diff = String(leftValue) < String(rightValue) ? -1 : String(leftValue) > String(rightValue) ? 1 : 0;
      if (diff !== 0) return direction === 'desc' ? -diff : diff;
    }
    return 0;
  });
}

/** 主处理器：返回 handled=false 时由中间件调用 next() 放行 */
/**
 * M10/E-17：前端错误上报（RUM）mock 计数——进程内累计，与 example-api 的
 * ClientErrorsService 同口径（「本实例累计」语义，多实例合计需日志侧聚合）
 */
let mockClientErrorTotal = 0;

/** E-17：错误来源枚举（与后端 CLIENT_ERROR_SOURCES / 前端 RumSource 同集合） */
const MOCK_CLIENT_ERROR_SOURCES = ['error', 'rejection', 'vue', 'resource'];

/** E-17：单批上限（与后端 CLIENT_ERROR_MAX_BATCH / 前端 RUM_MAX_BATCH 同值） */
const MOCK_CLIENT_ERROR_MAX_BATCH = 10;

/**
 * M10/E-17：前端错误上报（与 example-api ClientErrorsController 同构——公开端点，
 * 校验形状 / 来源枚举 / 条数上限，逐条落库不模拟（mock 无日志管道），
 * 响应回带 `{ received, total }`。校验失败 400/1001 且 details 带字段级定位）
 */
function handleClientErrors(body: Record<string, unknown>, res: ServerResponse, traceId: string): void {
  const app = body.app;
  if (typeof app !== 'string' || app.length === 0 || app.length > 64) {
    send(res, CODE.BAD_REQUEST, 'app 必填字符串，长度 1-64', null, traceId, [{ field: 'app', message: '必填字符串，长度 1-64' }]);
    return;
  }
  const reports = body.reports;
  if (!Array.isArray(reports)) {
    send(res, CODE.BAD_REQUEST, 'reports 需为数组', null, traceId, [{ field: 'reports', message: '需为数组' }]);
    return;
  }
  if (reports.length === 0) {
    send(res, CODE.BAD_REQUEST, 'reports 不能为空', null, traceId, [{ field: 'reports', message: '至少包含 1 条上报' }]);
    return;
  }
  if (reports.length > MOCK_CLIENT_ERROR_MAX_BATCH) {
    send(res, CODE.BAD_REQUEST, `单批最多 ${MOCK_CLIENT_ERROR_MAX_BATCH} 条上报`, null, traceId, [
      { field: 'reports', message: `条数不得超过 ${MOCK_CLIENT_ERROR_MAX_BATCH}` },
    ]);
    return;
  }
  const details: Array<{ field: string; message: string }> = [];
  reports.forEach((item, index) => {
    const report = (item ?? {}) as Record<string, unknown>;
    const field = (name: string): string => `reports[${index}].${name}`;
    if (typeof report.source !== 'string' || !MOCK_CLIENT_ERROR_SOURCES.includes(report.source)) {
      details.push({ field: field('source'), message: `需为 ${MOCK_CLIENT_ERROR_SOURCES.join(' / ')} 之一` });
    }
    if (typeof report.message !== 'string' || report.message.length === 0 || report.message.length > 2000) {
      details.push({ field: field('message'), message: '必填非空字符串，长度不得超过 2000' });
    }
    if (typeof report.page !== 'string' || report.page.length > 500) {
      details.push({ field: field('page'), message: '必填字符串，长度不得超过 500' });
    }
    if (typeof report.url !== 'string' || report.url.length > 2000) {
      details.push({ field: field('url'), message: '必填字符串，长度不得超过 2000' });
    }
    if (typeof report.repeat !== 'number' || !Number.isInteger(report.repeat) || report.repeat < 1 || report.repeat > 1000) {
      details.push({ field: field('repeat'), message: '需为 1-1000 的整数' });
    }
    if (typeof report.at !== 'string' || report.at.length === 0 || report.at.length > 40) {
      details.push({ field: field('at'), message: '必填字符串（ISO 8601），长度不得超过 40' });
    }
  });
  if (details.length > 0) {
    send(res, CODE.BAD_REQUEST, '前端错误上报载荷校验失败', null, traceId, details);
    return;
  }
  mockClientErrorTotal += reports.length;
  send(res, CODE.OK, 'ok', { received: reports.length, total: mockClientErrorTotal }, traceId);
}

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

  // ---- M10 E-09 附件上传（multipart 原始体，须在 readBody 消费请求流之前接管） ----
  if (path === '/files' && method === 'POST') {
    const auth = authenticate(database, req);
    if (!auth.ok) {
      send(res, auth.code, auth.message, null, traceId);
      return { handled: true };
    }
    const perm = requirePermission(database, auth.ctx, 'file:create');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    // 上限多留一段协议开销余量（boundary / 头部），超限断连 → 与超限 400 文案区分
    const raw = await readRawBody(req, MOCK_UPLOAD_MAX_BYTES + 64 * 1024);
    if (!raw) {
      send(res, CODE.BAD_REQUEST, `文件超出大小上限（${Math.floor(MOCK_UPLOAD_MAX_BYTES / 1024 / 1024)}MB）`, null, traceId);
      return { handled: true };
    }
    const part = extractMultipartFile(raw, req.headers['content-type']);
    if (!part || part.data.length === 0) {
      send(res, CODE.BAD_REQUEST, '请以 multipart/form-data 上传，字段名为 file', null, traceId);
      return { handled: true };
    }
    if (part.data.length > MOCK_UPLOAD_MAX_BYTES) {
      send(res, CODE.BAD_REQUEST, `文件超出大小上限（${Math.floor(MOCK_UPLOAD_MAX_BYTES / 1024 / 1024)}MB）`, null, traceId);
      return { handled: true };
    }
    const ext = uploadExtOf(part.fileName);
    if (!MOCK_UPLOAD_ALLOWED_EXTS.includes(ext)) {
      send(res, CODE.BAD_REQUEST, `不支持的文件类型：${ext || '(无扩展名)'}`, null, traceId);
      return { handled: true };
    }
    const id = randomId('file');
    const row: MockUploadFile = {
      id,
      ownerId: auth.ctx.user.id,
      originalName: part.fileName,
      storedName: `mock/${id}${ext}`,
      mimeType: part.contentType,
      size: part.data.length,
      deletedAt: null,
      createdAt: new Date().toISOString(),
      content: part.data,
    };
    database.uploadFiles.push(row);
    send(res, CODE.OK, 'ok', { id, url: `/api/v1/files/${id}/download`, originalName: row.originalName, size: row.size, mimeType: row.mimeType }, traceId);
    return { handled: true };
  }

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
  // E-07：已注册 OAuth2 提供方列表（与真实后端同形；mock 无 IdP，如实返回空 → 登录页不渲染入口）
  if (path === '/auth/oauth2/providers' && method === 'GET') {
    send(res, CODE.OK, 'ok', { providers: [] }, traceId);
    return { handled: true };
  }
  // E-17：前端 RUM 错误上报（与真实后端同构的公开端点——登录页与未登录态异常同样上报；
  // fire-and-forget 语义，前端不依赖响应内容）
  if (path === '/telemetry/client-errors' && method === 'POST') {
    handleClientErrors(body, res, traceId);
    return { handled: true };
  }

  // ---- 以下均需登录 ----
  const auth = authenticate(database, req);
  if (!auth.ok) {
    send(res, auth.code, auth.message, null, traceId);
    return { handled: true };
  }
  const ctx = auth.ctx;

  /** 本人资料视图：/auth/me 与 /auth/profile 共用；withContact 时附手机 / 邮箱 */
  const meView = (withContact: boolean): Record<string, unknown> => ({
    id: ctx.user.id,
    username: ctx.user.username,
    nickname: ctx.user.nickname,
    avatar: ctx.user.avatar,
    ...(withContact ? { phone: ctx.user.phone, email: ctx.user.email } : {}),
    roles: ctx.roles.map((r) => r.code),
    permissions: userPermissionCodes(database, ctx.user),
    dataScope: ctx.roles.some((r) => r.dataScope === 'all') ? 'all' : 'self',
  });

  // ---- 认证域 ----
  if (path === '/auth/me' && method === 'GET') {
    send(res, CODE.OK, 'ok', meView(false), traceId);
    return { handled: true };
  }
  // 本人资料（个人中心回显；只需 auth:me，不依赖 user:read）
  if (path === '/auth/profile' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'auth:me');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    send(res, CODE.OK, 'ok', meView(true), traceId);
    return { handled: true };
  }
  if (path === '/auth/profile' && method === 'PUT') {
    const perm = requirePermission(database, ctx, 'auth:me');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const patch: { nickname?: string; phone?: string; email?: string } = {};
    if (typeof body.nickname === 'string') patch.nickname = body.nickname;
    if (typeof body.phone === 'string') patch.phone = body.phone;
    if (typeof body.email === 'string') patch.email = body.email;
    if (Object.keys(patch).length === 0) {
      send(res, CODE.BAD_REQUEST, 'nickname / phone / email 至少传一个', null, traceId);
      return { handled: true };
    }
    for (const candidate of [patch.phone, patch.email]) {
      if (!candidate) continue;
      const occupied = database.users.find((u) => (u.phone === candidate || u.email === candidate) && u.id !== ctx.user.id);
      if (occupied) {
        send(res, CODE.CONFLICT, '手机号或邮箱已被其他账号占用', null, traceId);
        return { handled: true };
      }
    }
    Object.assign(ctx.user, patch);
    database.auditLogs.push({
      id: randomId('a'),
      userId: ctx.user.id,
      module: 'user',
      action: 'update',
      targetType: 'user',
      targetId: ctx.user.id,
      beforeValue: null,
      afterValue: { ...patch },
      ip: '127.0.0.1',
      userAgent: 'mock',
      traceId,
      createdAt: new Date().toISOString(),
    });
    // 与 GET /auth/profile 同构返回，前端保存后可直接刷新头部昵称
    send(res, CODE.OK, 'ok', meView(true), traceId);
    return { handled: true };
  }
  if (path === '/auth/menus' && method === 'GET') {
    const codes = userPermissionCodes(database, ctx.user);
    // 与真实后端行为对齐：只按权限码过滤，**不**按 visible 过滤（可见性是前端职责，
    // 侧边栏由 store/permission.ts 的 visibleMenus() 剪枝）。mock 若在此过滤 visible，
    // 前端剪枝逻辑在 dev 下永不被触发，「隐藏菜单仍出现在侧边栏」类缺陷将只在真机暴露。
    const tree = menuTree(database, (m) => m.permissionCode === null || codes.includes(m.permissionCode));
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
    const perm = requirePermission(database, ctx, 'auth:revoke-session');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
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
    // 排序（BUG-15，与 example-api 同语义）：白名单外字段 / 非法方向一律 400/1001；未传按 createdAt desc
    const parsedSort = parseMockSort(query.get('sort'), MOCK_USER_SORT_FIELDS);
    if ('error' in parsedSort) {
      send(res, CODE.BAD_REQUEST, parsedSort.error, null, traceId);
      return { handled: true };
    }
    items = applyMockSort(items, parsedSort.items, 'createdAt', 'desc');
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
    const parsedSort = parseMockSort(query.get('sort'), MOCK_ROLE_SORT_FIELDS);
    if ('error' in parsedSort) {
      send(res, CODE.BAD_REQUEST, parsedSort.error, null, traceId);
      return { handled: true };
    }
    const views = applyMockSort(
      database.roles.map(stripRole),
      parsedSort.items,
      'sort',
      'asc',
    );
    send(res, CODE.OK, 'ok', views, traceId);
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

  // ---- 权限树（M10 E-04：与后端同构——业务域 → 权限点（menu 类在前）→ 子资源预留） ----
  if (path === '/permissions/tree' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'permission:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const typeRank: Record<string, number> = { menu: 0, button: 1, api: 2 };
    const groups = new Map<string, MockPermission[]>();
    for (const permission of database.permissions) {
      const bucket = groups.get(permission.module) ?? [];
      bucket.push(permission);
      groups.set(permission.module, bucket);
    }
    const tree = [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([module, items]) => ({
        key: module,
        label: module,
        type: 'module' as const,
        codes: items.map((item) => item.code),
        children: items
          .slice()
          .sort((a, b) => (typeRank[a.type] ?? 3) - (typeRank[b.type] ?? 3) || a.code.localeCompare(b.code))
          .map((item) => ({ key: item.code, label: item.name, type: item.type, id: item.id, codes: [item.code], children: [] as unknown[] })),
      }));
    send(res, CODE.OK, 'ok', tree, traceId);
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
    const parsedSort = parseMockSort(query.get('sort'), MOCK_DICT_CATEGORY_SORT_FIELDS);
    if ('error' in parsedSort) {
      send(res, CODE.BAD_REQUEST, parsedSort.error, null, traceId);
      return { handled: true };
    }
    send(res, CODE.OK, 'ok', applyMockSort(database.dictCategories, parsedSort.items, 'id', 'asc'), traceId);
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
    const parsedSort = parseMockSort(query.get('sort'), MOCK_DICT_ITEM_SORT_FIELDS);
    if ('error' in parsedSort) {
      send(res, CODE.BAD_REQUEST, parsedSort.error, null, traceId);
      return { handled: true };
    }
    const items = applyMockSort(
      database.dictItems.filter((i) => i.categoryId === categoryId),
      parsedSort.items,
      'sort',
      'asc',
    );
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
    const unknownList = unknownMockAuditFilterParam(query);
    if (unknownList) {
      send(res, CODE.BAD_REQUEST, unknownList, null, traceId);
      return { handled: true };
    }
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
    items = applyMockAuditContractFilters(items, query);
    const parsedSort = parseMockSort(query.get('sort'), MOCK_AUDIT_SORT_FIELDS);
    if ('error' in parsedSort) {
      send(res, CODE.BAD_REQUEST, parsedSort.error, null, traceId);
      return { handled: true };
    }
    items = applyMockSort(items, parsedSort.items, 'createdAt', 'desc');
    send(res, CODE.OK, 'ok', paginate(items, page, pageSize), traceId);
    return { handled: true };
  }
  // 审计异步导出（N-02）——路由必须声明在 auditMatch 之前，否则 'export' 会被当成 id 命中详情分支
  if (path === '/audit-logs/export' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'audit:export');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    // 与列表同源的筛选条件（分页参数忽略，导出全量命中集）
    const unknownExport = unknownMockAuditFilterParam(query);
    if (unknownExport) {
      send(res, CODE.BAD_REQUEST, unknownExport, null, traceId);
      return { handled: true };
    }
    let rows = [...database.auditLogs];
    const userId = query.get('user_id');
    if (userId) rows = rows.filter((a) => a.userId === userId);
    const module = query.get('module');
    if (module) rows = rows.filter((a) => a.module === module);
    const action = query.get('action');
    if (action) rows = rows.filter((a) => a.action === action);
    const from = query.get('from');
    if (from) rows = rows.filter((a) => a.createdAt >= from);
    const to = query.get('to');
    if (to) rows = rows.filter((a) => a.createdAt <= to);
    rows = applyMockAuditContractFilters(rows, query);
    const parsedSort = parseMockSort(query.get('sort'), MOCK_AUDIT_SORT_FIELDS);
    if ('error' in parsedSort) {
      send(res, CODE.BAD_REQUEST, parsedSort.error, null, traceId);
      return { handled: true };
    }
    rows = applyMockSort(rows, parsedSort.items, 'createdAt', 'desc');

    // 产物快照在派发时固化（与后端「导出时的筛选结果」一致，不随后续新日志漂移）。
    // CSV 形状与 example-api 的 buildAuditCsv **逐字节同构**：同表头、同 BOM、同 CRLF、
    // 同引号转义——mock 与真实后端零差异，切真实 API 后下载产物行为不变。
    const header = ['id', 'createdAt', 'userId', 'module', 'action', 'targetType', 'targetId', 'ip', 'traceId', 'requestId', 'familyId', 'category', 'event', 'before', 'after'];
    const csvCell = (value: unknown): string => {
      if (value === null || value === undefined) return '""';
      const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
      return `"${text.replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
    };
    const lines = rows.map((a) =>
      [
        csvCell(a.id),
        csvCell(a.createdAt),
        csvCell(a.userId),
        csvCell(a.module),
        csvCell(a.action),
        csvCell(a.targetType),
        csvCell(a.targetId),
        csvCell(a.ip),
        csvCell(a.traceId),
        csvCell(a.requestId),
        csvCell(a.familyId),
        csvCell(a.category),
        csvCell(a.event),
        csvCell(a.beforeValue),
        csvCell(a.afterValue),
      ].join(','),
    );
    const job = dispatchJob(database, {
      type: 'audit.export',
      title: '审计日志导出',
      ownerId: ctx.user.id,
      durationMs: 3000,
      fileName: `audit-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
      artifact: `\uFEFF${[header.join(','), ...lines].join('\r\n')}\r\n`,
      simulateFail: query.get('simulate') === 'fail',
      traceId,
    });
    send(res, CODE.OK, 'ok', jobView(job), traceId);
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

  // ---------- M7 队列管理（PRD-007 FR-09 / C-06 契约 §3.8） ----------
  // 查看类需 system:queue:list，变更类需 system:queue:manage（与 C-08 契约 QUEUE_PERMISSIONS 同源）
  if (path === '/admin/queue/stats' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'system:queue:list');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const queue = database.queue;
    const totals = queue.queues.reduce(
      (acc, item) => ({
        waiting: acc.waiting + item.waiting,
        active: acc.active + item.active,
        completed: acc.completed + item.completed,
        deadLetter: acc.deadLetter + item.deadLetter,
        backlog: acc.backlog + item.backlog,
      }),
      { waiting: 0, active: 0, completed: 0, deadLetter: 0, backlog: 0 },
    );
    send(res, CODE.OK, 'ok', { driver: queue.driver, paused: queue.paused, consuming: queue.consuming && !queue.paused, queues: queue.queues, totals }, traceId);
    return { handled: true };
  }

  if (path === '/admin/queue/metrics' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'system:queue:list');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const counters = database.queue.counters;
    const executed = counters.succeeded + counters.failed;
    send(
      res,
      CODE.OK,
      'ok',
      {
        driver: database.queue.driver,
        ...counters,
        successRate: executed === 0 ? 0 : Number((counters.succeeded / executed).toFixed(6)),
        avgDurationMs: executed === 0 ? 0 : 42,
      },
      traceId,
    );
    return { handled: true };
  }

  if (path === '/admin/queue/handlers' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'system:queue:list');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    send(res, CODE.OK, 'ok', { names: ['demo.echo', 'demo.flaky', 'demo.permanent', 'demo.slow', 'demo.idempotent', 'order.timeout'] }, traceId);
    return { handled: true };
  }

  if (path === '/admin/queue/crons' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'system:queue:list');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    send(res, CODE.OK, 'ok', { enabled: true, items: database.queue.crons }, traceId);
    return { handled: true };
  }

  const cronTickMatch = /^\/admin\/queue\/crons\/([\w.-]+)\/tick$/.exec(path);
  if (cronTickMatch && method === 'POST') {
    const perm = requirePermission(database, ctx, 'system:queue:manage');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const name = decodeURIComponent(cronTickMatch[1] as string);
    const cron = database.queue.crons.find((c) => c.name === name);
    if (!cron) {
      send(res, CODE.NOT_FOUND, `定时任务不存在：${name}`, null, traceId);
      return { handled: true };
    }
    // mock 单实例：加锁条目也能取到锁；真实多副本下由分布式锁决定 acquired
    cron.runs += 1;
    cron.lastResult = 'ok';
    cron.lastRunAt = new Date().toISOString();
    database.queue.counters.cronTicked += 1;
    send(res, CODE.OK, 'ok', { results: [{ name, acquired: true }] }, traceId);
    return { handled: true };
  }

  if (path === '/admin/queue/dead-letters' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'system:queue:list');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const queueName = query.get('queue');
    // 分页（与 @fw/queue 改造同形）：不传时等价于第一页 + 全量 total，行为向后兼容；
    // 每页上限 MOCK_DEAD_LETTER_PAGE_MAX（M10/E-16，与 MQ_DEAD_LETTER_PAGE_MAX 默认值同口径）
    const page = Math.max(1, Number(query.get('page') ?? '1'));
    const pageSize = Math.min(MOCK_DEAD_LETTER_PAGE_MAX, Math.max(1, Number(query.get('pageSize') ?? '20')));
    const items = queueName ? database.queue.deadLetters.filter((item) => item.queue === queueName) : database.queue.deadLetters;
    const windowed = paginate(items, page, pageSize);
    send(res, CODE.OK, 'ok', { total: windowed.total, items: windowed.items, page: windowed.page, pageSize: windowed.pageSize }, traceId);
    return { handled: true };
  }

  const requeueMatch = /^\/admin\/queue\/dead-letters\/([\w-]+)\/requeue$/.exec(path);
  if (requeueMatch && method === 'POST') {
    const perm = requirePermission(database, ctx, 'system:queue:manage');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const id = requeueMatch[1] as string;
    const found = database.queue.deadLetters.find((item) => item.id === id);
    if (!found) {
      send(res, CODE.OK, 'ok', { id, requeued: false }, traceId);
      return { handled: true };
    }
    database.queue.deadLetters = database.queue.deadLetters.filter((item) => item.id !== id);
    database.queue.counters.dispatched += 1;
    const target = database.queue.queues.find((item) => item.name === found.queue);
    if (target) {
      target.deadLetter = Math.max(0, target.deadLetter - 1);
      target.waiting += 1;
      target.backlog += 1;
    }
    send(res, CODE.OK, 'ok', { id, requeued: true }, traceId);
    return { handled: true };
  }

  if (path === '/admin/queue/dead-letters' && method === 'DELETE') {
    const perm = requirePermission(database, ctx, 'system:queue:manage');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const queueName = query.get('queue');
    const before = database.queue.deadLetters.length;
    database.queue.deadLetters = queueName ? database.queue.deadLetters.filter((item) => item.queue !== queueName) : [];
    const removed = before - database.queue.deadLetters.length;
    for (const item of database.queue.queues) {
      if (!queueName || item.name === queueName) item.deadLetter = 0;
    }
    send(res, CODE.OK, 'ok', { removed }, traceId);
    return { handled: true };
  }

  if (path === '/admin/queue/pause' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'system:queue:manage');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    database.queue.paused = true;
    send(res, CODE.OK, 'ok', { paused: true }, traceId);
    return { handled: true };
  }

  if (path === '/admin/queue/resume' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'system:queue:manage');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    database.queue.paused = false;
    send(res, CODE.OK, 'ok', { resumed: true }, traceId);
    return { handled: true };
  }

  if (path === '/admin/queue/drain' && method === 'DELETE') {
    const perm = requirePermission(database, ctx, 'system:queue:manage');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const queueName = query.get('queue');
    let removed = 0;
    for (const item of database.queue.queues) {
      if (queueName && item.name !== queueName) continue;
      removed += item.waiting;
      item.waiting = 0;
      item.backlog = item.active;
    }
    send(res, CODE.OK, 'ok', { removed }, traceId);
    return { handled: true };
  }

  // ---- N-01 租户域（五端点；管理面是 @IgnoreTenant 的，权限双重要求：tenant:* + system:tenant:ignore） ----
  // 豁免校验只作用于 /tenants* 路径，避免把未命中请求从 404 变成 403
  // M13 SaaS 运营面（api-spec §3.21）：@IgnoreTenant 跨租户维护路径 + ops:saas:* 读写分离
  if (path === '/saas' || path.startsWith('/saas/')) {
    return await handleSaasRoutes(req, res, database, ctx, path, method, query, traceId);
  }

  if (path === '/tenants' || path.startsWith('/tenants/')) {
    const hasTenantIgnore = requirePermission(database, ctx, 'system:tenant:ignore');
    if (!hasTenantIgnore.ok) {
      send(res, hasTenantIgnore.code, hasTenantIgnore.message, null, traceId);
      return { handled: true };
    }
  }

  if (path === '/tenants' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'tenant:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const page = Math.max(1, Number(query.get('page') ?? '1'));
    const pageSize = Math.min(200, Math.max(1, Number(query.get('pageSize') ?? '20')));
    const keyword = query.get('keyword')?.trim();
    const isolation = query.get('isolation');
    const status = query.get('status');
    // 与后端同语义：非法枚举值一律 400，不静默忽略
    if (isolation !== null && isolation !== '' && isolation !== 'shared' && isolation !== 'dedicated') {
      send(res, CODE.BAD_REQUEST, 'isolation 仅支持 shared / dedicated', null, traceId);
      return { handled: true };
    }
    if (status !== null && status !== '' && status !== '0' && status !== '1') {
      send(res, CODE.BAD_REQUEST, 'status 仅支持 0（停用）/ 1（启用）', null, traceId);
      return { handled: true };
    }
    let items = [...database.tenants];
    if (keyword) items = items.filter((t) => t.code.includes(keyword) || t.name.includes(keyword));
    if (isolation) items = items.filter((t) => t.isolation === isolation);
    if (status) items = items.filter((t) => String(t.status) === status);
    const parsedSort = parseMockSort(query.get('sort'), MOCK_TENANT_SORT_FIELDS);
    if ('error' in parsedSort) {
      send(res, CODE.BAD_REQUEST, parsedSort.error, null, traceId);
      return { handled: true };
    }
    items = applyMockSort(items, parsedSort.items, 'createdAt', 'desc');
    const windowed = paginate(items, page, pageSize);
    send(res, CODE.OK, 'ok', { total: windowed.total, page: windowed.page, pageSize: windowed.pageSize, items: windowed.items.map(tenantView) }, traceId);
    return { handled: true };
  }

  if (path === '/tenants' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'tenant:create');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const isolation = body.isolation;
    const plan = typeof body.plan === 'string' ? body.plan.trim() || null : null;
    const dbUrl = typeof body.dbUrl === 'string' ? body.dbUrl.trim() || null : null;
    const expireAt = typeof body.expireAt === 'string' && body.expireAt ? body.expireAt : null;
    if (!code || !name || !isolation) {
      send(res, CODE.BAD_REQUEST, 'code / name / isolation 必填', null, traceId);
      return { handled: true };
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,63})$/.test(code)) {
      send(res, CODE.BAD_REQUEST, '租户编码仅允许小写字母 / 数字 / 连字符，长度 1–64，且以字母或数字开头', null, traceId);
      return { handled: true };
    }
    if (isolation !== 'shared' && isolation !== 'dedicated') {
      send(res, CODE.BAD_REQUEST, 'isolation 仅支持 shared / dedicated', null, traceId);
      return { handled: true };
    }
    if (isolation === 'dedicated' && !dbUrl) {
      send(res, CODE.BAD_REQUEST, 'dedicated 隔离级别必须提供独立库连接串 dbUrl', null, traceId);
      return { handled: true };
    }
    if (isolation === 'shared' && dbUrl) {
      send(res, CODE.BAD_REQUEST, 'shared 隔离级别不接受 dbUrl（连接串会在迁移时清除）', null, traceId);
      return { handled: true };
    }
    if (database.tenants.some((t) => t.code === code)) {
      send(res, CODE.CONFLICT, `租户编码已存在：${code}`, null, traceId);
      return { handled: true };
    }
    const nextId = String(database.tenants.reduce((max, t) => (/^[0-9]+$/.test(t.id) ? Math.max(max, Number(t.id)) : max), 0) + 1);
    const now = new Date().toISOString();
    const tenant: MockTenant = { id: nextId, code, name, isolation, plan, status: 1, expireAt, dbUrl, createdAt: now, updatedAt: now };
    database.tenants.push(tenant);
    send(res, CODE.OK, 'ok', tenantView(tenant), traceId);
    return { handled: true };
  }

  const tenantMatch = /^\/tenants\/([\w-]+)$/.exec(path);
  if (tenantMatch && method === 'PUT') {
    const perm = requirePermission(database, ctx, 'tenant:update');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const tenant = database.tenants.find((t) => t.id === tenantMatch[1]);
    if (!tenant) {
      send(res, CODE.NOT_FOUND, '租户不存在', null, traceId);
      return { handled: true };
    }
    const status = body.status;
    if (status !== undefined && status !== 0 && status !== 1) {
      send(res, CODE.BAD_REQUEST, 'status 只能为 0（停用）或 1（启用）', null, traceId);
      return { handled: true };
    }
    if (tenant.id === '0' && status === 0) {
      send(res, CODE.STATE_NOT_ALLOWED, '存量单租户（legacy）不可停用', null, traceId);
      return { handled: true };
    }
    if (typeof body.name === 'string' && body.name.trim()) tenant.name = body.name.trim();
    if (body.plan !== undefined) tenant.plan = typeof body.plan === 'string' ? body.plan.trim() || null : null;
    if (status !== undefined) tenant.status = status;
    if (body.expireAt !== undefined) tenant.expireAt = typeof body.expireAt === 'string' && body.expireAt ? body.expireAt : null;
    tenant.updatedAt = new Date().toISOString();
    send(res, CODE.OK, 'ok', tenantView(tenant), traceId);
    return { handled: true };
  }

  if (tenantMatch && method === 'DELETE') {
    const perm = requirePermission(database, ctx, 'tenant:delete');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const tenant = database.tenants.find((t) => t.id === tenantMatch[1]);
    if (!tenant) {
      send(res, CODE.NOT_FOUND, '租户不存在', null, traceId);
      return { handled: true };
    }
    if (tenant.id === '0') {
      send(res, CODE.STATE_NOT_ALLOWED, '存量单租户（legacy）不可停用：所有历史数据归属该租户，停用即全站不可访问', null, traceId);
      return { handled: true };
    }
    tenant.status = 0;
    tenant.updatedAt = new Date().toISOString();
    send(res, CODE.OK, 'ok', tenantView(tenant), traceId);
    return { handled: true };
  }

  const tenantMigrateMatch = /^\/tenants\/([\w-]+)\/migrate$/.exec(path);
  if (tenantMigrateMatch && method === 'POST') {
    const perm = requirePermission(database, ctx, 'tenant:manage');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const target = body.isolation;
    if (target !== 'shared' && target !== 'dedicated') {
      send(res, CODE.BAD_REQUEST, 'isolation 仅支持 shared / dedicated', null, traceId);
      return { handled: true };
    }
    const tenant = database.tenants.find((t) => t.id === tenantMigrateMatch[1]);
    if (!tenant) {
      send(res, CODE.NOT_FOUND, '租户不存在', null, traceId);
      return { handled: true };
    }
    if (tenant.isolation === target) {
      send(res, CODE.STATE_NOT_ALLOWED, `租户已是 ${target} 隔离级别，无需迁移`, null, traceId);
      return { handled: true };
    }
    if (tenant.id === '0') {
      send(res, CODE.STATE_NOT_ALLOWED, '存量单租户（legacy）不可迁移隔离级别：其数据分布在共享库，切换数据源会整体失联', null, traceId);
      return { handled: true };
    }
    const dbUrl = typeof body.dbUrl === 'string' ? body.dbUrl.trim() || null : null;
    if (target === 'dedicated' && !dbUrl) {
      send(res, CODE.BAD_REQUEST, '迁移到 dedicated 必须提供独立库连接串 dbUrl', null, traceId);
      return { handled: true };
    }
    const job = dispatchJob(database, {
      type: 'tenant.migrate',
      title: `租户 ${tenant.code} 迁移至${target === 'dedicated' ? '独立库' : '共享库'}`,
      ownerId: ctx.user.id,
      durationMs: 4000,
      simulateFail: body.simulate === 'fail',
      mutate: { tenantId: tenant.id, isolation: target, dbUrl: target === 'dedicated' ? dbUrl : null },
      traceId,
    });
    send(res, CODE.OK, 'ok', jobView(job), traceId);
    return { handled: true };
  }

  // ---- M9 配置中心域（PRD-009 FR-08：与真实后端同白名单 / 同校验语义 / 同错误码 / 同审计可见性） ----
  if (path === '/configs' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'system:config:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    send(res, CODE.OK, 'ok', { configs: mockConfigList(database), meta: mockConfigMeta(database) }, traceId);
    return { handled: true };
  }
  const configKeyMatch = /^\/configs\/([\w.-]+)$/.exec(path);
  if (configKeyMatch && method === 'PUT') {
    const perm = requirePermission(database, ctx, 'system:config:write');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const key = configKeyMatch[1] as string;
    const entry = MOCK_CONFIG_ENTRIES.find((item) => item.key === key);
    if (!entry) {
      // 已知但不可热更（boot 键）→ 5001；完全未知 → 5003（与 @fw/config-center describeKey 同语义）
      const known = MOCK_KNOWN_CONFIG_PATHS.has(key);
      send(res, known ? CODE.CONFIG_NOT_HOT : CODE.CONFIG_NOT_FOUND, known ? `配置键 ${key} 不可热更新（boot 键或不在白名单）` : `配置键 ${key} 不存在`, null, traceId);
      return { handled: true };
    }
    if (body.value === undefined) {
      send(res, CODE.BAD_REQUEST, 'body.value 必填（新配置值，JSON 语义）', null, traceId);
      return { handled: true };
    }
    const invalid = validateMockConfigValue(entry, body.value);
    if (invalid) {
      database.configLastError = `键「${key}」新值非法：${invalid}`;
      mockRecordConfigAudit(database, ctx, key, mockCurrentValue(database, entry), body.value, false, invalid, traceId);
      send(res, CODE.CONFIG_INVALID_VALUE, `配置键 ${key} 的新值非法`, null, traceId, [{ field: key, message: invalid }]);
      return { handled: true };
    }
    const oldValue = mockCurrentValue(database, entry);
    if (JSON.stringify(oldValue) === JSON.stringify(body.value)) {
      send(res, CODE.OK, 'ok', { key, oldValue, newValue: oldValue, snapshotVersion: database.configVersion }, traceId);
      return { handled: true };
    }
    // 应用覆盖 + 版本号推进 + 审计（与真实管道一致：成功变更才生效）
    database.configOverrides[key] = body.value;
    database.configUpdatedAt[key] = new Date().toISOString();
    database.configVersion += 1;
    mockRecordConfigAudit(database, ctx, key, oldValue, body.value, true, null, traceId);
    send(res, CODE.OK, 'ok', { key, oldValue, newValue: body.value, snapshotVersion: database.configVersion }, traceId);
    return { handled: true };
  }

  // ---- M10 E-12 SSE 实时推送：mock 不实现流式推送，明确拒绝而非静默 200 ----
  // 前端据此自动降级为轮询兜底（useJobCenter 的 sseStatus → 'closed'），
  // 而不是拿到一张永远建不起来的票据后卡在「实时」态。
  if (path === '/events/ticket' && method === 'POST') {
    send(res, CODE.INTERNAL, 'mock 环境不提供 SSE 实时推送（前端自动降级为轮询兜底）', null, traceId);
    return { handled: true };
  }

  // ---------- M10 E-13 站内信 / 通知中心（api-spec §3.14） ----------
  // 与真实后端同语义：`notification:read` 守卫；归属人即边界（他人的消息一律 404 不泄露存在性）。
  // mock 不产事件（无 SSE 事件面），消息来自 db 预置 + 前端动作产生。
  if (path === '/notifications' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'notification:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.get('pageSize') ?? '20') || 20));
    const unreadOnly = query.get('unreadOnly') === 'true';
    const mine = database.notifications
      .filter((item) => item.userId === ctx.user.id)
      .filter((item) => !unreadOnly || item.readAt === null)
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    const items = mine.slice((page - 1) * pageSize, page * pageSize).map(notificationView);
    send(res, CODE.OK, 'ok', { total: mine.length, unread: unreadCount(database, ctx.user.id), items, page, pageSize }, traceId);
    return { handled: true };
  }

  if (path === '/notifications/unread-count' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'notification:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    send(res, CODE.OK, 'ok', { unread: unreadCount(database, ctx.user.id) }, traceId);
    return { handled: true };
  }

  if (path === '/notifications/read-all' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'notification:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const now = new Date().toISOString();
    let updated = 0;
    for (const item of database.notifications) {
      if (item.userId === ctx.user.id && item.readAt === null) {
        item.readAt = now;
        updated += 1;
      }
    }
    send(res, CODE.OK, 'ok', { updated }, traceId);
    return { handled: true };
  }

  const notifReadMatch = /^\/notifications\/([\w-]+)\/read$/.exec(path);
  if (notifReadMatch && method === 'POST') {
    const perm = requirePermission(database, ctx, 'notification:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const item = findOwnedNotification(database, ctx, notifReadMatch[1] as string);
    if (!item) {
      send(res, CODE.NOT_FOUND, '消息不存在', null, traceId);
      return { handled: true };
    }
    if (item.readAt === null) item.readAt = new Date().toISOString();
    send(res, CODE.OK, 'ok', notificationView(item), traceId);
    return { handled: true };
  }

  const notifDeleteMatch = /^\/notifications\/([\w-]+)$/.exec(path);
  if (notifDeleteMatch && method === 'DELETE') {
    const perm = requirePermission(database, ctx, 'notification:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const item = findOwnedNotification(database, ctx, notifDeleteMatch[1] as string);
    if (!item) {
      send(res, CODE.NOT_FOUND, '消息不存在', null, traceId);
      return { handled: true };
    }
    database.notifications = database.notifications.filter((row) => row.id !== item.id);
    send(res, CODE.OK, 'ok', { id: item.id, removed: true }, traceId);
    return { handled: true };
  }

  // ---- M10 E-09 附件元数据与下载（api-spec §3.19；登录即可，语义同任务产物下载） ----
  const fileMetaMatch = /^\/files\/([\w-]+)$/.exec(path);
  if (fileMetaMatch && method === 'GET') {
    const row = database.uploadFiles.find((item) => item.id === fileMetaMatch[1] && item.deletedAt === null);
    if (!row) {
      send(res, CODE.NOT_FOUND, '文件不存在或已删除', null, traceId);
      return { handled: true };
    }
    send(res, CODE.OK, 'ok', { id: row.id, originalName: row.originalName, size: row.size, mimeType: row.mimeType, createdAt: row.createdAt }, traceId);
    return { handled: true };
  }

  const fileDownloadMatch = /^\/files\/([\w-]+)\/download$/.exec(path);
  if (fileDownloadMatch && method === 'GET') {
    const row = database.uploadFiles.find((item) => item.id === fileDownloadMatch[1] && item.deletedAt === null);
    if (!row) {
      send(res, CODE.NOT_FOUND, '文件不存在或已删除', null, traceId);
      return { handled: true };
    }
    // 裸文件流（非统一信封），与后端 UploadController.download 的 @Res() 直写一致；逐字节回放
    res.statusCode = 200;
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.originalName)}`);
    res.end(row.content);
    return { handled: true };
  }

  // ---- N-02 异步任务域（登录即可；归属人校验在处理器内，不泄露存在性一律 404） ----
  const jobProgressMatch = /^\/jobs\/([\w-]+)\/progress$/.exec(path);
  if (jobProgressMatch && method === 'GET') {
    const job = findOwnedJob(database, ctx, jobProgressMatch[1] as string);
    if (!job) {
      send(res, CODE.NOT_FOUND, '任务不存在或已过期', null, traceId);
      return { handled: true };
    }
    advanceJob(database, job);
    send(res, CODE.OK, 'ok', jobView(job), traceId);
    return { handled: true };
  }

  const jobRetryMatch = /^\/jobs\/([\w-]+)\/retry$/.exec(path);
  if (jobRetryMatch && method === 'POST') {
    const job = findOwnedJob(database, ctx, jobRetryMatch[1] as string);
    if (!job) {
      send(res, CODE.NOT_FOUND, '任务不存在或已过期', null, traceId);
      return { handled: true };
    }
    if (job.status === 'running' || job.status === 'pending') {
      send(res, CODE.STATE_NOT_ALLOWED, '任务正在执行中，无需重跑', null, traceId);
      return { handled: true };
    }
    if (job.status === 'succeeded') {
      send(res, CODE.STATE_NOT_ALLOWED, '任务已成功，无需重跑', null, traceId);
      return { handled: true };
    }
    job.status = 'pending';
    job.progress = 0;
    job.error = null;
    job.message = '已重新派发';
    job.startedAt = Date.now();
    job.updatedAt = new Date().toISOString();
    advanceJob(database, job);
    send(res, CODE.OK, 'ok', jobView(job), traceId);
    return { handled: true };
  }

  const jobDownloadMatch = /^\/jobs\/([\w-]+)\/download$/.exec(path);
  if (jobDownloadMatch && method === 'GET') {
    const job = findOwnedJob(database, ctx, jobDownloadMatch[1] as string);
    advanceJob(database, job);
    if (!job || !job.artifact) {
      send(res, CODE.NOT_FOUND, '任务产物不存在或已过期', null, traceId);
      return { handled: true };
    }
    // 产物是裸文本流（非统一信封），与后端 JobsController.download 的 @Res() 直写一致
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(job.fileName ?? `job-${job.id}.dat`)}`);
    res.end(job.artifact);
    return { handled: true };
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

/** 菜单输出（扁平存储，无需裁剪 children；保留函数为输出口径统一） */
function stripMenu(menu: MockMenu): MockMenu {
  return { ...menu };
}

/** 租户输出（N-01）：绝不下传连接串，独立库只用布尔位表达「是否已配置」 */
function tenantView(tenant: MockTenant): Omit<MockTenant, 'dbUrl'> & { dedicatedDbConfigured: boolean } {
  const { dbUrl: _dbUrl, ...rest } = tenant;
  return { ...rest, dedicatedDbConfigured: Boolean(tenant.dbUrl) };
}

/** 异步任务派发参数（内部） */
interface DispatchJobOptions {
  type: string;
  title: string;
  ownerId: string;
  /** 虚拟执行时长（毫秒）：进度按时间线推进，供轮询退避演练 */
  durationMs: number;
  fileName?: string | null;
  artifact?: string | null;
  /** mock 调试开关：强制走失败路径，演练任务条重试 */
  simulateFail?: boolean;
  /** 完成时应用的控制面变更（迁移任务） */
  mutate?: { tenantId: string; isolation: 'shared' | 'dedicated'; dbUrl: string | null };
  traceId: string;
}

/**
 * 派发异步任务（N-02，镜像后端 JobCenterService.create）
 *
 * 立即返回 pending 视图，进度由后续 progress 轮询按虚拟时间线推进；
 * 产物在派发时快照固化（与后端「导出时的筛选结果」语义一致）。
 */
function dispatchJob(database: MockDb, options: DispatchJobOptions): MockJob {
  const now = Date.now();
  const job: MockJob = {
    id: `job${randomId('')}`,
    type: options.type,
    title: options.title,
    ownerId: options.ownerId,
    status: 'pending',
    progress: 0,
    durationMs: options.durationMs,
    startedAt: now,
    message: '已派发，等待执行',
    error: null,
    traceId: options.traceId,
    fileName: options.fileName ?? null,
    artifact: options.artifact ?? null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    ...(options.simulateFail ? { simulateFail: true } : {}),
    ...(options.mutate ? { mutate: options.mutate } : {}),
  };
  database.jobs.push(job);
  return job;
}

/** 任务对外视图（JobView 形状，与 example-api 的 JobView 逐字段一致） */
function jobView(job: MockJob): Record<string, unknown> {
  return {
    id: job.id,
    type: job.type,
    title: job.title,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    traceId: job.traceId,
    fileName: job.fileName,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** 按 id + 归属人查任务（非归属人 / 不存在都返回 null，对外一律 404 不泄露存在性） */
function findOwnedJob(database: MockDb, ctx: AuthContext, id: string): MockJob | null {
  const job = database.jobs.find((item) => item.id === id);
  if (!job || job.ownerId !== ctx.user.id) return null;
  return job;
}

/** M10 E-13：站内信对外视图（NotificationView 形状，剥掉 userId 等内部字段） */
function notificationView(item: MockNotification): Record<string, unknown> {
  return {
    id: item.id,
    kind: item.kind,
    level: item.level,
    title: item.title,
    content: item.content,
    refType: item.refType,
    refId: item.refId,
    traceId: item.traceId,
    read: item.readAt !== null,
    readAt: item.readAt,
    createdAt: item.createdAt,
  };
}

/** M10 E-13：本人未读数 */
function unreadCount(database: MockDb, userId: string): number {
  return database.notifications.filter((item) => item.userId === userId && item.readAt === null).length;
}

/** M10 E-13：按 id + 归属人查站内信（非归属人 / 不存在都返回 null，对外一律 404） */
function findOwnedNotification(database: MockDb, ctx: AuthContext, id: string): MockNotification | null {
  const item = database.notifications.find((row) => row.id === id);
  if (!item || item.userId !== ctx.user.id) return null;
  return item;
}

/** 派发瞬间的宽限窗口（毫秒）：让前端至少能观察到一次 pending，与后端的「立即执行」差异可接受 */
const JOB_PENDING_GRACE_MS = 200;

/**
 * 推进任务虚拟时间线（N-02）：elapsed / duration 决定进度百分比；
 * 到达终态时把 mutate 变更应用到租户（仅一次，镜像后端 runner 的控制面切换）。
 */
function advanceJob(database: MockDb, job: MockJob | null): void {
  if (!job) return;
  if (job.status !== 'pending' && job.status !== 'running') return;
  const elapsed = Date.now() - job.startedAt;
  if (elapsed < JOB_PENDING_GRACE_MS) {
    job.status = 'pending';
    job.progress = 0;
    job.message = '已派发，等待执行';
  } else if (elapsed >= job.durationMs) {
    if (job.simulateFail) {
      job.status = 'failed';
      job.error = '模拟失败（mock 调试开关 simulate=fail）：用于演练任务条的重试路径';
      job.message = '执行失败，可重试';
    } else {
      job.status = 'succeeded';
      job.progress = 100;
      job.message = job.artifact ? '已完成，可下载' : '已完成';
      if (job.mutate) {
        const tenant = database.tenants.find((t) => t.id === job.mutate?.tenantId);
        if (tenant) {
          tenant.isolation = job.mutate.isolation;
          tenant.dbUrl = job.mutate.dbUrl;
          tenant.updatedAt = new Date().toISOString();
        }
        job.mutate = undefined;
      }
    }
  } else {
    job.status = 'running';
    job.progress = Math.min(99, Math.floor((elapsed / job.durationMs) * 100));
    job.message = '执行中';
  }
  job.updatedAt = new Date().toISOString();
}

/** ---------- M9 配置中心（PRD-009 FR-08：与真实后端同构） ---------- */

/** 白名单键定义：与 @fw/config 的 ENV_HOT_KEYS + env-schema 约束同源（type: 'string' 仅 log.level） */
interface MockConfigEntry {
  key: string;
  envKey: string;
  initial: number | string;
  type: 'number' | 'string';
  /** number 型的取值范围（int 表示必须整数）；string 型用 options 枚举 */
  min?: number;
  max?: number;
  int?: boolean;
  options?: readonly string[];
}

/** 热更新白名单 12 键（与 example-api 管道同一份约束语义；M10/E-16 起含 web.keepAliveMax） */
const MOCK_CONFIG_ENTRIES: MockConfigEntry[] = [
  { key: 'log.level', envKey: 'LOG_LEVEL', initial: 'info', type: 'string', options: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] },
  { key: 'log.maxBytes', envKey: 'LOG_MAX_BYTES', initial: 8192, type: 'number', min: 512, int: true },
  { key: 'cache.ttl', envKey: 'CACHE_TTL', initial: 300, type: 'number', min: 1, max: 86400, int: true },
  { key: 'cache.nullTtl', envKey: 'CACHE_NULL_TTL', initial: 60, type: 'number', min: 1, max: 3600, int: true },
  { key: 'cache.ttlJitter', envKey: 'CACHE_TTL_JITTER', initial: 0.1, type: 'number', min: 0, max: 1 },
  { key: 'cache.slowMs', envKey: 'CACHE_SLOW_MS', initial: 50, type: 'number', min: 1, max: 10000, int: true },
  { key: 'cache.lockTtl', envKey: 'CACHE_LOCK_TTL', initial: 30, type: 'number', min: 1, max: 3600, int: true },
  { key: 'mq.rateLimit', envKey: 'MQ_RATE_LIMIT', initial: 0, type: 'number', min: 0, max: 100000, int: true },
  { key: 'mq.concurrency', envKey: 'MQ_CONCURRENCY', initial: 10, type: 'number', min: 1, max: 1000, int: true },
  { key: 'otel.sampleRatio', envKey: 'OTEL_SAMPLE_RATIO', initial: 0.1, type: 'number', min: 0, max: 1 },
  { key: 'tenant.cacheTtl', envKey: 'TENANT_CACHE_TTL', initial: 60, type: 'number', min: 1, max: 3600, int: true },
  { key: 'web.keepAliveMax', envKey: 'WEB_KEEP_ALIVE_MAX', initial: 12, type: 'number', min: 1, max: 1000, int: true },
];

/** 已知键全集（boot 键 → 5001 的判别依据；与 @fw/config ENV_KEY_PATHS 值集逐一同源，84 键） */
const MOCK_KNOWN_CONFIG_PATHS: ReadonlySet<string> = new Set([
  'app.env', 'app.port', 'log.level', 'log.maxBytes', 'db.driver', 'db.url', 'db.slowMs',
  'cache.driver', 'cache.url', 'cache.prefix', 'cache.ttl', 'cache.maxItems', 'cache.failOpen',
  'cache.nullTtl', 'cache.ttlJitter', 'cache.lockTtl', 'cache.tagTtl', 'cache.slowMs', 'cache.maxValueBytes',
  'auth.strategy', 'auth.accessTtl', 'auth.refreshTtl', 'auth.maxFailed', 'auth.lockMinutes',
  'auth.refreshGraceSeconds', 'auth.passwordPolicy', 'auth.allowRegister', 'auth.apiKeys',
  'auth.apiKeySignSecret', 'auth.oauth2.providers', 'auth.oauth2.redirectWhitelist',
  'jwt.secret', 'jwt.secretPrev',
  'mq.driver', 'mq.url', 'mq.prefix', 'mq.concurrency', 'mq.maxAttempts', 'mq.backoff', 'mq.jobTimeout',
  'mq.cronEnabled', 'mq.rateLimit', 'mq.deadLetterMax', 'mq.deadLetterPageMax', 'mq.shutdownTimeout', 'mq.stalledMs',
  'shutdown.timeoutSeconds',
  'tenant.enabled', 'tenant.order', 'tenant.headerName', 'tenant.baseDomain', 'tenant.jwtClaim',
  'tenant.cacheTtl', 'tenant.dbKey',
  'transport.driver', 'transport.url', 'transport.prefix', 'transport.timeoutMs', 'transport.role',
  'transport.instanceId', 'transport.shutdownTimeout',
  'otel.enabled', 'otel.serviceName', 'otel.exporterUrl', 'otel.sampleRatio', 'otel.sampleErrors',
  'configCenter.enabled', 'configCenter.driver', 'configCenter.file', 'configCenter.pollSeconds',
  'configCenter.nacos.serverAddr', 'configCenter.nacos.dataId', 'configCenter.nacos.group',
  'configCenter.nacos.namespace', 'configCenter.nacos.username', 'configCenter.nacos.password',
  'configCenter.historyMax',
  'jobCenter.driver', 'jobCenter.artifactMaxMb',
  'rateLimit.capacity', 'rateLimit.refillPerSecond', 'rateLimit.whitelist', 'rateLimit.failOpen', 'rateLimit.dryRun',
  'audit.archiveRetentionDays', 'audit.archiveBatchSize',
  'web.keepAliveMax',
]);

/** 校验新值（与 env-schema 同约束）；返回 null = 合法，否则为拒绝原因 */
function validateMockConfigValue(entry: MockConfigEntry, value: unknown): string | null {
  if (entry.type === 'string') {
    if (typeof value !== 'string' || !entry.options?.includes(value)) {
      return `取值必须是 ${entry.options?.join(' / ')}`;
    }
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return '取值必须是数字';
  if (entry.int && !Number.isInteger(value)) return '取值必须是整数';
  if (entry.min !== undefined && value < entry.min) return `取值不能小于 ${entry.min}`;
  if (entry.max !== undefined && value > entry.max) return `取值不能大于 ${entry.max}`;
  return null;
}

/** 当前生效值（覆盖优先，回退白名单初始值） */
function mockCurrentValue(database: MockDb, entry: MockConfigEntry): unknown {
  if (entry.key in database.configOverrides) return database.configOverrides[entry.key];
  return entry.initial;
}

/** GET /configs 列表（boot 键不进列表，与真实后端一致） */
function mockConfigList(database: MockDb): Array<Record<string, unknown>> {
  return MOCK_CONFIG_ENTRIES.map((entry) => {
    const overridden = entry.key in database.configOverrides;
    return {
      key: entry.key,
      value: mockCurrentValue(database, entry),
      source: overridden ? 'runtime' : 'env',
      hot: true,
      envKey: entry.envKey,
      updatedAt: overridden ? (database.configUpdatedAt[entry.key] ?? null) : null,
    };
  });
}

/** GET /configs 运行元信息 */
function mockConfigMeta(database: MockDb): Record<string, unknown> {
  return {
    driver: 'file',
    snapshotVersion: database.configVersion,
    pollSeconds: 5,
    lastAppliedAt: Object.values(database.configUpdatedAt).filter(Boolean).at(-1) ?? null,
    lastError: database.configLastError,
  };
}

/** 配置变更审计（module=config，与真实审计桥同构：before/after 值 + source/operator/ok） */
function mockRecordConfigAudit(
  database: MockDb,
  ctx: AuthContext,
  key: string,
  oldValue: unknown,
  newValue: unknown,
  ok: boolean,
  reason: string | null,
  traceId: string,
): void {
  database.auditLogs.push({
    id: `a-config-${database.auditLogs.length + 1}`,
    userId: ctx.user.id,
    module: 'config',
    action: 'update',
    targetType: 'config',
    targetId: key,
    beforeValue: { value: oldValue },
    afterValue: ok
      ? { value: newValue, source: 'api', operator: ctx.user.username, ok: true }
      : { value: newValue, source: 'api', operator: ctx.user.username, ok: false, reason },
    ip: '127.0.0.1',
    userAgent: null,
    traceId,
    createdAt: new Date().toISOString(),
  });
}


/** M13 生命周期合法迁移表（与 @fw/saas lifecycle.machine 逐条一致；mock 与真实后端同语义） */
const SAAS_TRANSITIONS: Record<string, Partial<Record<string, string>>> = {
  pending: { activate: 'active' },
  active: { expire: 'grace', freeze: 'frozen', terminate: 'terminated' },
  grace: { freeze: 'frozen', resume: 'active', terminate: 'terminated' },
  frozen: { resume: 'active', terminate: 'terminated' },
  terminated: { dispose: 'terminated' },
};

/** M13/M14 SaaS 运营端点（api-spec §3.21）：mock 与 @fw/saas 领域语义逐条对应 */
async function handleSaasRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  database: MockDb,
  ctx: AuthContext,
  path: string,
  method: string,
  query: URLSearchParams,
  traceId: string,
): Promise<HandleResult> {
  const saas = database.saas;

  // ---- 平台运营总览（M14 FR-14-14：mock 近似派生，真机由后端 overview 端点组装） ----
  if (path === '/saas/usage/overview' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'ops:saas:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    // 配额风险：枚举 mock 窗口行（windowType 近似标 day），limit>0 且 ≥80% 入选
    const quotaRisks = Object.entries(saas.usageWindows)
      .filter(([key, w]) => !key.includes('|deduped') && Number(w.limitValue) > 0 && (Number(w.used) / Number(w.limitValue)) * 100 >= 80)
      .map(([key, w]) => {
        const [tenantId, quotaKey] = key.split('|');
        return { tenantId, quotaKey, windowType: 'day', windowStart: new Date().toISOString().slice(0, 10), used: String(w.used), limitValue: String(w.limitValue), ratio: Math.round((Number(w.used) / Number(w.limitValue)) * 100) };
      })
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 20);
    // 五态计数：无日志租户近似 active（mock 演示数据语义）
    const statusOf = (tenantId: string) => saas.lifecycleLogs.filter((l) => l.tenantId === tenantId).slice(-1)[0]?.toStatus ?? 'active';
    const tenantIds = new Set([...saas.subscriptions.map((s) => s.tenantId), ...saas.lifecycleLogs.map((l) => l.tenantId)]);
    const tenantCounts: Record<string, number> = { pending: 0, active: 0, grace: 0, frozen: 0, terminated: 0 };
    for (const t of tenantIds) tenantCounts[statusOf(t)] += 1;
    // 7 天内到期订阅（expireAt 为日期串或 ISO）
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const expiringSubscriptions = saas.subscriptions
      .filter((s) => s.status === 'active' && s.expireAt && s.expireAt.slice(0, 10) <= soon)
      .map((s) => ({ subscriptionId: s.id, tenantId: s.tenantId, expireAt: s.expireAt }));
    const recentTransitions = saas.lifecycleLogs.slice(-10).reverse();
    send(res, 0, 'ok', { quotaRisks, expiringSubscriptions, tenantCounts, recentTransitions }, traceId);
    return { handled: true };
  }

  // ---- 套餐（读 + 写） ----
  if (path === '/saas/plans' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'ops:saas:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    send(res, 0, 'ok', saas.plans, traceId);
    return { handled: true };
  }

  // M14 FR-14-05：创建套餐（code 唯一 → 1003，与 PlanService.createPlan 同语义）
  if (path === '/saas/plans' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'ops:saas:write');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const body = await readBody(req);
    const code = String(body.code ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (!code || !name) {
      send(res, 1001, 'code 与 name 必填', null, traceId);
      return { handled: true };
    }
    if (saas.plans.some((p) => p.code === code)) {
      send(res, 1003, `套餐编码已存在：${code}`, null, traceId);
      return { handled: true };
    }
    const plan = { id: `plan-mock-${saas.plans.length + 1}-${Date.now()}`, code, name, description: body.description ? String(body.description) : null };
    saas.plans.push(plan);
    send(res, 0, 'ok', plan, traceId);
    return { handled: true };
  }

  const versionMatch = path.match(/^\/saas\/plans\/([^/]+)\/versions$/);
  if (versionMatch && method === 'GET') {
    const perm = requirePermission(database, ctx, 'ops:saas:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const versions = saas.planVersions.filter((v) => v.planId === versionMatch[1]);
    send(res, 0, 'ok', versions.map((v) => ({ ...v, quotas: saas.planQuotas.filter((q) => q.planVersionId === v.id) })), traceId);
    return { handled: true };
  }

  // M14 FR-14-06：发布新版本（版本 = 最大 +1，发布后不可变；配额字典缺失 → 1002，与 publishVersion 同语义）
  if (versionMatch && method === 'POST') {
    const perm = requirePermission(database, ctx, 'ops:saas:write');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const planId = versionMatch[1];
    const plan = saas.plans.find((p) => p.id === planId);
    if (!plan) {
      send(res, 1002, `套餐不存在：${planId}`, null, traceId);
      return { handled: true };
    }
    const body = await readBody(req);
    const quotas = Array.isArray(body.quotas) ? body.quotas : [];
    if (quotas.length === 0) {
      send(res, 1001, 'quotas 必填且至少一条', null, traceId);
      return { handled: true };
    }
    for (const q of quotas) {
      if (!q?.quotaKey || !saas.quotaDefinitions.some((d) => d.key === q.quotaKey)) {
        send(res, 1002, `配额字典未登记：${q?.quotaKey ?? '(empty)'}`, null, traceId);
        return { handled: true };
      }
      if (!Number.isFinite(Number(q.limitValue)) || Number(q.limitValue) < 0) {
        send(res, 1001, `quotas[].limitValue 非法：${String(q?.limitValue)}`, null, traceId);
        return { handled: true };
      }
    }
    const next = saas.planVersions.filter((v) => v.planId === planId).reduce((max, v) => Math.max(max, v.version), 0) + 1;
    const version = { id: `pv-mock-${planId}-${next}`, planId, version: next, status: 'published', remark: body.remark ? String(body.remark) : null, publishedAt: new Date().toISOString() };
    saas.planVersions.push(version);
    for (const q of quotas) {
      const existing = saas.planQuotas.find((x) => x.planVersionId === version.id && x.quotaKey === q.quotaKey);
      const row = { planVersionId: version.id, quotaKey: q.quotaKey, limitValue: String(Math.floor(Number(q.limitValue))), execution: q.execution ?? null };
      if (existing) Object.assign(existing, row);
      else saas.planQuotas.push(row);
    }
    send(res, 0, 'ok', { ...version, quotas: saas.planQuotas.filter((x) => x.planVersionId === version.id) }, traceId);
    return { handled: true };
  }

  // ---- 订阅（写 + 读） ----
  if (path === '/saas/tenant-subscriptions' && method === 'POST') {
    const perm = requirePermission(database, ctx, 'ops:saas:write');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const body = await readBody(req);
    const tenantId = String(body.tenantId ?? '');
    const planCode = String(body.planCode ?? 'default');
    if (!tenantId) {
      send(res, 1001, '参数错误', null, traceId, [{ field: 'tenantId', message: '必填' }]);
      return { handled: true };
    }
    if (saas.subscriptions.some((s) => s.tenantId === tenantId && s.status === 'active')) {
      send(res, 1003, '唯一约束冲突', null, traceId);
      return { handled: true };
    }
    const plan = saas.plans.find((p) => p.code === planCode);
    const version = plan ? saas.planVersions.filter((v) => v.planId === plan.id && v.status === 'published').sort((a, b) => b.version - a.version)[0] : undefined;
    if (!plan || !version) {
      send(res, 1002, '资源不存在', null, traceId);
      return { handled: true };
    }
    const sub = {
      id: `sub-mock-${saas.subscriptions.length + 1}`,
      tenantId,
      planId: plan.id,
      planVersionId: version.id,
      status: 'active',
      effectiveAt: new Date().toISOString(),
      expireAt: body.expireAt ? String(body.expireAt) : null,
      closedAt: null,
      reason: null,
    };
    saas.subscriptions.push(sub);
    // 版本快照：plan_quotas → tenant_quotas（source=plan_snapshot）
    for (const q of saas.planQuotas.filter((q) => q.planVersionId === version.id)) {
      const existing = saas.tenantQuotas.find((o) => o.tenantId === tenantId && o.quotaKey === q.quotaKey);
      if (existing) {
        existing.overrideValue = q.limitValue;
        existing.source = 'plan_snapshot';
      } else {
        saas.tenantQuotas.push({ tenantId, quotaKey: q.quotaKey, overrideValue: q.limitValue, execution: q.execution, source: 'plan_snapshot' });
      }
    }
    send(res, 0, 'ok', sub, traceId);
    return { handled: true };
  }

  const cancelMatch = path.match(/^\/saas\/tenant-subscriptions\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    const perm = requirePermission(database, ctx, 'ops:saas:write');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const body = await readBody(req);
    const sub = saas.subscriptions.find((s) => s.id === cancelMatch[1]);
    if (!sub) {
      send(res, 1002, '资源不存在', null, traceId);
      return { handled: true };
    }
    if (sub.status === 'active') {
      sub.status = 'cancelled';
      sub.closedAt = new Date().toISOString();
      sub.reason = body.reason ? String(body.reason) : null;
    }
    send(res, 0, 'ok', { id: sub.id, cancelled: true }, traceId);
    return { handled: true };
  }

  // M14 FR-14-07：订阅分页列表（tenantId/planCode/status/expireFrom/expireTo 过滤 + plan 信息补全，
  // 排序 effectiveAt desc + id asc，与 Prisma/Fake 实现同语义）
  if (path === '/saas/tenant-subscriptions' && method === 'GET') {
    const perm = requirePermission(database, ctx, 'ops:saas:read');
    if (!perm.ok) {
      send(res, perm.code, perm.message, null, traceId);
      return { handled: true };
    }
    const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.get('pageSize') ?? '20') || 20));
    const tenantIdFilter = query.get('tenantId') ?? '';
    const planCodeFilter = query.get('planCode') ?? '';
    const statusFilter = query.get('status') ?? '';
    const expireFrom = query.get('expireFrom') ? new Date(query.get('expireFrom')!) : null;
    const expireTo = query.get('expireTo') ? new Date(query.get('expireTo')!) : null;
    if (statusFilter && !['active', 'expired', 'cancelled'].includes(statusFilter)) {
      send(res, 1001, 'status 仅支持 active/expired/cancelled', null, traceId);
      return { handled: true };
    }
    const planIdFilter = planCodeFilter ? saas.plans.find((p) => p.code === planCodeFilter)?.id ?? null : null;
    if (planCodeFilter && !planIdFilter) {
      send(res, 0, 'ok', { items: [], total: 0, page, pageSize }, traceId);
      return { handled: true };
    }
    const rows = saas.subscriptions
      .filter((s) => {
        if (tenantIdFilter && s.tenantId !== tenantIdFilter) return false;
        if (planIdFilter && s.planId !== planIdFilter) return false;
        if (statusFilter && s.status !== statusFilter) return false;
        const exp = s.expireAt ? new Date(s.expireAt) : null;
        if (expireFrom && (exp === null || exp < expireFrom)) return false;
        if (expireTo && (exp === null || exp > expireTo)) return false;
        return true;
      })
      .sort((a, b) => {
        const t = new Date(b.effectiveAt).getTime() - new Date(a.effectiveAt).getTime();
        return t !== 0 ? t : a.id.localeCompare(b.id);
      });
    const enrich = (s: (typeof saas.subscriptions)[number]) => {
      const plan = saas.plans.find((p) => p.id === s.planId);
      const version = saas.planVersions.find((v) => v.id === s.planVersionId);
      return { ...s, planCode: plan?.code ?? null, planName: plan?.name ?? null, planVersion: version?.version ?? null };
    };
    send(res, 0, 'ok', { items: rows.slice((page - 1) * pageSize, page * pageSize).map(enrich), total: rows.length, page, pageSize }, traceId);
    return { handled: true };
  }

  // ---- 按租户的读/写端点 ----
  const tenantMatch = path.match(/^\/saas\/tenants\/([^/]+)(?:\/(.*))?$/);
  if (tenantMatch) {
    const tenantId = tenantMatch[1];
    const subPath = tenantMatch[2] ?? '';

    if (subPath === 'subscription' && method === 'GET') {
      const perm = requirePermission(database, ctx, 'ops:saas:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      send(res, 0, 'ok', saas.subscriptions.find((s) => s.tenantId === tenantId && s.status === 'active') ?? null, traceId);
      return { handled: true };
    }

    if (subPath === 'quotas' && method === 'GET') {
      const perm = requirePermission(database, ctx, 'ops:saas:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const effective = saas.tenantQuotas.filter((o) => o.tenantId === tenantId).map((o) => ({
        tenantId,
        quotaKey: o.quotaKey,
        limitValue: o.overrideValue,
        execution: o.execution ?? 'hard',
        source: o.source,
      }));
      send(res, 0, 'ok', effective, traceId);
      return { handled: true };
    }

    // M14 FR-14-12：用量趋势（mock 不存原始事件——从当前 day 窗口派生单点；真实趋势见后端 listEvents 聚合）
    if (subPath === 'usage/trend' && method === 'GET') {
      const perm = requirePermission(database, ctx, 'ops:saas:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const quotaKey = query.get('quotaKey') ?? '';
      const windowStart = new Date().toISOString().slice(0, 10);
      const win = saas.usageWindows[`${tenantId}|${quotaKey}|${windowStart}`];
      const points = win ? [{ bucketStart: `${windowStart}T00:00:00.000Z`, quantity: win.used, eventCount: Number(win.used) }] : [];
      send(res, 0, 'ok', { quotaKey, bucketType: 'hour', points }, traceId);
      return { handled: true };
    }

    // M14 FR-14-12：用量事件明细（mock 无原始事件存储，返回空列表；真机/CI 由后端 listEvents 提供）
    if (subPath === 'usage/events' && method === 'GET') {
      const perm = requirePermission(database, ctx, 'ops:saas:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      send(res, 0, 'ok', { items: [], total: 0, page: 1, pageSize: Number(query.get('pageSize') ?? 50) }, traceId);
      return { handled: true };
    }

    if (subPath === 'usage' && method === 'GET') {
      const perm = requirePermission(database, ctx, 'ops:saas:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const quotaKey = query.get('quotaKey') ?? '';
      if (!quotaKey) {
        send(res, 1001, 'quotaKey 必填', null, traceId);
        return { handled: true };
      }
      const override = saas.tenantQuotas.find((o) => o.tenantId === tenantId && o.quotaKey === quotaKey);
      const def = saas.quotaDefinitions.find((d) => d.key === quotaKey);
      const windowStart = new Date().toISOString().slice(0, 10);
      const win = saas.usageWindows[`${tenantId}|${quotaKey}|${windowStart}`] ?? { used: '0', limitValue: override?.overrideValue ?? '0', execution: def?.execution ?? 'hard' };
      send(res, 0, 'ok', { totalQuantity: win.used, eventCount: Number(win.used), limitValue: win.limitValue, execution: win.execution, windowStart: `${windowStart}T00:00:00.000Z`, windowEnd: `${windowStart}T23:59:59.999Z` }, traceId);
      return { handled: true };
    }

    // M14 FR-14-12：用量趋势（mock 不存原始事件——从当前 day 窗口派生单点；真实趋势见后端 listEvents 聚合）
    if (subPath === 'usage/trend' && method === 'GET') {
      const perm = requirePermission(database, ctx, 'ops:saas:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const quotaKey = query.get('quotaKey') ?? '';
      const windowStart = new Date().toISOString().slice(0, 10);
      const win = saas.usageWindows[`${tenantId}|${quotaKey}|${windowStart}`];
      const points = win ? [{ bucketStart: `${windowStart}T00:00:00.000Z`, quantity: win.used, eventCount: Number(win.used) }] : [];
      send(res, 0, 'ok', { quotaKey, bucketType: 'hour', points }, traceId);
      return { handled: true };
    }

    // M14 FR-14-12：用量事件明细（mock 无原始事件存储，返回空列表；真机/CI 由后端 listEvents 提供）
    if (subPath === 'usage/events' && method === 'GET') {
      const perm = requirePermission(database, ctx, 'ops:saas:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      send(res, 0, 'ok', { items: [], total: 0, page: 1, pageSize: Number(query.get('pageSize') ?? 50) }, traceId);
      return { handled: true };
    }

    if (subPath === 'usage/events' && method === 'POST') {
      const perm = requirePermission(database, ctx, 'ops:saas:write');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const body = await readBody(req);
      const quotaKey = String(body.quotaKey ?? '');
      const quantity = Number(body.quantity ?? 0);
      const idempotencyKey = String(body.idempotencyKey ?? '');
      if (!quotaKey || !(quantity > 0) || !idempotencyKey) {
        send(res, 1001, '参数错误', null, traceId, [{ field: 'quotaKey', message: 'quotaKey / quantity(正数) / idempotencyKey 必填' }]);
        return { handled: true };
      }
      const windowStart = new Date().toISOString().slice(0, 10);
      const winKey = `${tenantId}|${quotaKey}|${windowStart}`;
      const idemKey = `${winKey}|${idempotencyKey}`;
      if (saas.usageWindows[idemKey] !== undefined) {
        send(res, 0, 'ok', { result: 'deduped' }, traceId);
        return { handled: true };
      }
      const def = saas.quotaDefinitions.find((d) => d.key === quotaKey);
      const override = saas.tenantQuotas.find((o) => o.tenantId === tenantId && o.quotaKey === quotaKey);
      const limit = BigInt(override?.overrideValue ?? '0');
      const win = saas.usageWindows[winKey] ?? { used: '0', limitValue: limit.toString(), execution: def?.execution ?? 'hard' };
      if (BigInt(win.used) + BigInt(quantity) > limit) {
        send(res, 4029, '配额已达上限', null, traceId, [
          { field: 'metricKey', message: quotaKey },
          { field: 'used', message: win.used },
          { field: 'limit', message: win.limitValue },
        ]);
        return { handled: true };
      }
      win.used = (BigInt(win.used) + BigInt(quantity)).toString();
      saas.usageWindows[winKey] = win;
      saas.usageWindows[idemKey] = { used: '1', limitValue: '0', execution: 'deduped-marker' };
      send(res, 0, 'ok', { result: 'ok', used: win.used, limit: win.limitValue }, traceId);
      return { handled: true };
    }

    if (subPath === 'lifecycle' && method === 'POST') {
      const perm = requirePermission(database, ctx, 'ops:saas:write');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const body = await readBody(req);
      const action = String(body.action ?? '');
      const from = saas.lifecycleLogs.filter((l) => l.tenantId === tenantId).slice(-1)[0]?.toStatus ?? 'pending';
      const to = SAAS_TRANSITIONS[from]?.[action];
      if (!to) {
        // 幂等重入：当前态已是该动作的合法目标态 → alreadyApplied（与 @fw/saas 语义一致）
        const reachedFrom = Object.keys(SAAS_TRANSITIONS).find((s) => SAAS_TRANSITIONS[s]?.[action] === from);
        if (reachedFrom) {
          send(res, 0, 'ok', { from, to: from, alreadyApplied: true }, traceId);
          return { handled: true };
        }
        send(res, 4030, '生命周期状态不允许该操作', null, traceId, [
          { field: 'from', message: from },
          { field: 'action', message: action },
        ]);
        return { handled: true };
      }
      saas.lifecycleLogs.push({
        tenantId,
        fromStatus: from,
        toStatus: to,
        action,
        actorType: 'user',
        actorId: ctx.user.id,
        reason: body.reason ? String(body.reason) : null,
        createdAt: new Date().toISOString(),
      });
      send(res, 0, 'ok', { from, to, alreadyApplied: false }, traceId);
      return { handled: true };
    }

    // M14 FR-14-07：租户订阅历史（完整列表，含 cancelled/expired；排序与 plan 信息补全同列表端点）
    if (subPath === 'subscriptions/history' && method === 'GET') {
      const perm = requirePermission(database, ctx, 'ops:saas:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const rows = saas.subscriptions
        .filter((s) => s.tenantId === tenantId)
        .sort((a, b) => {
          const t = new Date(b.effectiveAt).getTime() - new Date(a.effectiveAt).getTime();
          return t !== 0 ? t : a.id.localeCompare(b.id);
        })
        .map((s) => {
          const plan = saas.plans.find((p) => p.id === s.planId);
          const version = saas.planVersions.find((v) => v.id === s.planVersionId);
          return { ...s, planCode: plan?.code ?? null, planName: plan?.name ?? null, planVersion: version?.version ?? null };
        });
      send(res, 0, 'ok', rows, traceId);
      return { handled: true };
    }

    // M14 FR-14-03：状态推导与 POST lifecycle 同源（日志末条 ?? pending）；allowedActions 由迁移表派生（与真实后端同语义）
    if (subPath === 'lifecycle/status' && method === 'GET') {
      const perm = requirePermission(database, ctx, 'ops:saas:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      const status = saas.lifecycleLogs.filter((l) => l.tenantId === tenantId).slice(-1)[0]?.toStatus ?? 'pending';
      send(res, 0, 'ok', { status, allowedActions: Object.keys(SAAS_TRANSITIONS[status] ?? {}) }, traceId);
      return { handled: true };
    }

    if (subPath === 'lifecycle/logs' && method === 'GET') {
      const perm = requirePermission(database, ctx, 'ops:saas:read');
      if (!perm.ok) {
        send(res, perm.code, perm.message, null, traceId);
        return { handled: true };
      }
      send(res, 0, 'ok', saas.lifecycleLogs.filter((l) => l.tenantId === tenantId), traceId);
      return { handled: true };
    }
  }

  return { handled: false };
}

/**
 * @file M10 E-07 认证策略端到端冒烟（PRD-010 AC6）
 * @description 自带服务生命周期（应用 3780 / stub IdP 3790）：本机起一个最小 OAuth2 IdP
 *   （authorize / token / userinfo 三端点），走完整授权码链路——providers 列表 → authorize 302
 *   （回调白名单 + state）→ IdP 授权 → callback 换 token → /auth/me 会话成立；反向验证：
 *   回调地址不在白名单 1001、伪造/重放 state 3001、provider 与 state 不一致 3001、错授权码 3001、
 *   未注册提供方 3001；apikey 签名段（AUTH_API_KEY_SIGN_SECRET 配置后强制验签）：
 *   缺签名头 3001、正确 HMAC 200、篡改签名 3001、过期时间戳 3001。
 *   前置：dev.db 已迁移并播种（`pnpm exec tsx prisma/seed.ts`）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api
 */

import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT_MAIN = 3780;
const PORT_IDP = 3790;
const CWD = fileURLToPath(new URL('..', import.meta.url));
const DB_URL = `file:${path.join(CWD, 'prisma/dev.db')}`;
const BASE = `http://127.0.0.1:${PORT_MAIN}`;
const IDP = `http://127.0.0.1:${PORT_IDP}`;

/** 回调地址（fragment 段放行 / json 段放行两个形态都覆盖） */
const CALLBACK = `${BASE}/api/v1/auth/oauth2/demo/callback`;
const WHITELIST = `${BASE}/api/v1/auth/oauth2/demo/callback`;
const API_KEY = 'k-smoke-e07';
const SIGN_SECRET = 'smoke-sign-secret-e07';

const results = [];

/** 记录并打印一项断言 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** HTTP 请求：返回 { status, body, headers, text }（不自动跟随重定向） */
async function call(url, options = {}) {
  const res = await fetch(url, { redirect: 'manual', ...options });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, headers: res.headers, text, location: res.headers.get('location') };
}

/** 启动应用实例 */
async function startInstance() {
  const providers = JSON.stringify({
    demo: {
      clientId: 'client-1',
      clientSecret: 'secret-1',
      authorizeUrl: `${IDP}/authorize`,
      tokenUrl: `${IDP}/token`,
      userInfoUrl: `${IDP}/userinfo`,
      scope: 'openid email',
    },
    other: {
      clientId: 'client-2',
      clientSecret: 'secret-2',
      authorizeUrl: `${IDP}/authorize`,
      tokenUrl: `${IDP}/token`,
      userInfoUrl: `${IDP}/userinfo`,
    },
  });
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: {
      ...process.env,
      APP_PORT: String(PORT_MAIN),
      DB_URL,
      DB_DRIVER: 'sqlite',
      AUTH_OAUTH2_PROVIDERS: providers,
      AUTH_OAUTH2_REDIRECT_WHITELIST: WHITELIST,
      AUTH_API_KEYS: `${API_KEY}:svc-dict:dict:read`,
      AUTH_API_KEY_SIGN_SECRET: SIGN_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  for (let i = 0; i < 60; i++) {
    try {
      const { status } = await call(`${BASE}/health`);
      if (status === 200) return { child, output: () => output };
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`实例在 30s 内未就绪：\n${output.slice(-2000)}`);
}

/** 启动 stub IdP：authorize（校验 client 与 redirect 后发 code）/ token（校验凭据与 code）/ userinfo（Bearer） */
async function startStubIdp() {
  const validCodes = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', IDP);
    const sendJson = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/authorize') {
      if (url.searchParams.get('client_id') !== 'client-1' && url.searchParams.get('client_id') !== 'client-2') {
        sendJson(400, { error: 'invalid_client' });
        return;
      }
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      if (!redirectUri.startsWith(BASE)) {
        sendJson(400, { error: 'invalid_redirect_uri' });
        return;
      }
      const code = `code-${Math.random().toString(36).slice(2)}`;
      validCodes.set(code, url.searchParams.get('client_id'));
      const joiner = redirectUri.includes('?') ? '&' : '?';
      res.writeHead(302, { location: `${redirectUri}${joiner}code=${code}&state=${url.searchParams.get('state') ?? ''}` });
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk.toString()));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        const code = form.get('code') ?? '';
        if (form.get('grant_type') !== 'authorization_code' || !validCodes.has(code) || form.get('client_id') !== validCodes.get(code) || form.get('client_secret') !== 'secret-1') {
          sendJson(400, { error: 'invalid_grant' });
          return;
        }
        validCodes.delete(code);
        sendJson(200, { access_token: 'idp-access-token', token_type: 'Bearer', expires_in: 3600 });
      });
      return;
    }
    if (url.pathname === '/userinfo') {
      if (req.headers.authorization !== 'Bearer idp-access-token') {
        sendJson(401, { error: 'invalid_token' });
        return;
      }
      sendJson(200, { sub: 'u-1', email: 'alice@example.com', name: 'Alice' });
      return;
    }
    sendJson(404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(PORT_IDP, '127.0.0.1', resolve));
  return server;
}

/** 走 IdP 授权段：authorize → 提取回调 Location 中的 code 与 state */
async function idpAuthorize(authorizeLocation) {
  const res = await call(authorizeLocation);
  if (res.status !== 302) throw new Error(`stub IdP authorize 未按预期 302：${res.status}`);
  const callbackUrl = new URL(res.location);
  return { code: callbackUrl.searchParams.get('code'), state: callbackUrl.searchParams.get('state') };
}

/** apikey 签名（与 @fw/auth apiKeySignature 同算法：HMAC-SHA256(secret, key\nts\METHOD\path) hex） */
function sign(secret, key, timestamp, method, reqPath) {
  return createHmac('sha256', secret).update(`${key}\n${timestamp}\n${method}\n${reqPath}`).digest('hex');
}

async function main() {
  console.log('—— M10 E-07 认证策略端到端冒烟（OAuth2 授权码 + apikey 签名） ——\n');
  const idp = await startStubIdp();
  const instance = await startInstance();
  try {
    // ---------- A. 提供方列表 ----------
    console.log('—— 阶段 A：providers 列表 ——');
    const providers = await call(`${BASE}/api/v1/auth/oauth2/providers`);
    check('GET /auth/oauth2/providers 公开可访问且列出已注册提供方',
      providers.status === 200 && Array.isArray(providers.body?.data?.providers) &&
        providers.body.data.providers.includes('demo') && providers.body.data.providers.includes('other'),
      `providers=${JSON.stringify(providers.body?.data?.providers)}`);

    // ---------- B. authorize：白名单 + state ----------
    console.log('\n—— 阶段 B：authorize 跳转（回调白名单 + state） ——');
    const authorize = await call(`${BASE}/api/v1/auth/oauth2/demo/authorize?redirect_uri=${encodeURIComponent(CALLBACK)}&response_mode=json`);
    check('authorize 302 到 IdP 授权端点且携带 state',
      authorize.status === 302 && (authorize.location ?? '').startsWith(`${IDP}/authorize`) && (authorize.location ?? '').includes('state='),
      `location=${(authorize.location ?? '').slice(0, 80)}...`);
    const evilAuthorize = await call(`${BASE}/api/v1/auth/oauth2/demo/authorize?redirect_uri=${encodeURIComponent('http://evil.example.com/cb')}`);
    check('反向验证：回调地址不在白名单 → 400/1001（默认安全）',
      evilAuthorize.status === 400 && evilAuthorize.body?.code === 1001, `code=${evilAuthorize.body?.code}`);
    const noRedirect = await call(`${BASE}/api/v1/auth/oauth2/demo/authorize`);
    check('反向验证：redirect_uri 缺失 → 400/1001', noRedirect.status === 400 && noRedirect.body?.code === 1001);
    const ghostProvider = await call(`${BASE}/api/v1/auth/oauth2/ghost/authorize?redirect_uri=${encodeURIComponent(CALLBACK)}`);
    check('反向验证：未注册提供方 → 401/3001（不静默放行）',
      ghostProvider.status === 401 && ghostProvider.body?.code === 3001, `code=${ghostProvider.body?.code}`);

    // ---------- C. 授权码端到端（json 模式）----------
    console.log('\n—— 阶段 C：授权码端到端（跳转 → 授权 → 换 token → 登录会话） ——');
    const { code, state } = await idpAuthorize(authorize.location);
    const callback = await call(`${BASE}/api/v1/auth/oauth2/demo/callback?code=${code}&state=${state}&response_mode=json`);
    const accessToken = callback.body?.data?.accessToken ?? null;
    check('callback（response_mode=json）返回 TokenPair 且本地身份为 alice（IdP email 绑定）',
      callback.status === 200 && typeof accessToken === 'string' && accessToken.length > 20 &&
        callback.body?.data?.user?.username === 'alice',
      `status=${callback.status} username=${callback.body?.data?.user?.username}`);
    const me = await call(`${BASE}/api/v1/auth/me`, { headers: { authorization: `Bearer ${accessToken}` } });
    check('换发的 access token 访问 /auth/me → 会话成立',
      me.status === 200 && me.body?.data?.username === 'alice', `status=${me.status} username=${me.body?.data?.username}`);

    // ---------- D. 反向验证：state 一次性 / 跨提供方 / 错授权码 ----------
    console.log('\n—— 阶段 D：反向验证（state 重放 / 跨提供方 / 错 code） ——');
    const replay = await call(`${BASE}/api/v1/auth/oauth2/demo/callback?code=${code}&state=${state}&response_mode=json`);
    check('反向验证：同一 state 二次回调 → 401/3001（一次性消费，防重放）',
      replay.status === 401 && replay.body?.code === 3001, `code=${replay.body?.code}`);
    const crossProvider = await idpAuthorize(
      (await call(`${BASE}/api/v1/auth/oauth2/demo/authorize?redirect_uri=${encodeURIComponent(CALLBACK)}&response_mode=json`)).location,
    );
    const cross = await call(`${BASE}/api/v1/auth/oauth2/other/callback?code=${crossProvider.code}&state=${crossProvider.state}&response_mode=json`);
    check('反向验证：demo 签发的 state 拿到 other 回调 → 401/3001（跨提供方重放）',
      cross.status === 401 && cross.body?.code === 3001, `code=${cross.body?.code}`);
    const badCode = await idpAuthorize(
      (await call(`${BASE}/api/v1/auth/oauth2/demo/authorize?redirect_uri=${encodeURIComponent(CALLBACK)}&response_mode=json`)).location,
    );
    const wrongCode = await call(`${BASE}/api/v1/auth/oauth2/demo/callback?code=forged-code&state=${badCode.state}&response_mode=json`);
    check('反向验证：伪造授权码（IdP 400 invalid_grant）→ 401/3001',
      wrongCode.status === 401 && wrongCode.body?.code === 3001, `code=${wrongCode.body?.code}`);

    // ---------- E. 浏览器流（fragment 回传） ----------
    console.log('\n—— 阶段 E：浏览器流（302 + fragment 携带令牌） ——');
    const browserAuthorize = await call(`${BASE}/api/v1/auth/oauth2/demo/authorize?redirect_uri=${encodeURIComponent(CALLBACK)}`);
    const browserRound = await idpAuthorize(browserAuthorize.location);
    const fragmentRedirect = await call(`${BASE}/api/v1/auth/oauth2/demo/callback?code=${browserRound.code}&state=${browserRound.state}`);
    check('缺省 response_mode → 302 回 redirect_uri 且令牌在 fragment（不进服务器日志）',
      fragmentRedirect.status === 302 && (fragmentRedirect.location ?? '').startsWith(`${CALLBACK}#access_token=`) &&
        (fragmentRedirect.location ?? '').includes('refresh_token='),
      `location 前缀=${(fragmentRedirect.location ?? '').slice(0, 60)}...`);

    // ---------- F. apikey 签名模式 ----------
    console.log('\n—— 阶段 F：apikey 签名（AUTH_API_KEY_SIGN_SECRET 配置后强制验签） ——');
    const dictPath = '/api/v1/open/ping';
    const noSign = await call(`${BASE}${dictPath}`, { headers: { 'x-api-key': API_KEY } });
    check('反向验证：配置签名密钥后缺签名头 → 401/3001', noSign.status === 401 && noSign.body?.code === 3001);
    const ts = String(Math.floor(Date.now() / 1000));
    const goodSign = sign(SIGN_SECRET, API_KEY, ts, 'GET', dictPath);
    const okKey = await call(`${BASE}${dictPath}`, {
      headers: { 'x-api-key': API_KEY, 'x-api-timestamp': ts, 'x-api-sign': goodSign },
    });
    check('正确 HMAC 签名 → 200（apikey 策略路由 /open/ping，身份与 scope 回显）',
      okKey.status === 200 && okKey.body?.data?.subject === 'svc-dict' && okKey.body?.data?.via === 'apikey',
      `status=${okKey.status} subject=${okKey.body?.data?.subject}`);
    const tampered = await call(`${BASE}${dictPath}`, {
      headers: { 'x-api-key': API_KEY, 'x-api-timestamp': ts, 'x-api-sign': 'f'.repeat(64) },
    });
    check('反向验证：篡改签名 → 401/3001', tampered.status === 401 && tampered.body?.code === 3001);
    const expired = await call(`${BASE}${dictPath}`, {
      headers: {
        'x-api-key': API_KEY,
        'x-api-timestamp': String(Math.floor(Date.now() / 1000) - 3600),
        'x-api-sign': sign(SIGN_SECRET, API_KEY, String(Math.floor(Date.now() / 1000) - 3600), 'GET', dictPath),
      },
    });
    check('反向验证：时间戳超偏差（1h 前）→ 401/3001（防重放窗口）', expired.status === 401 && expired.body?.code === 3001);
  } finally {
    idp.close();
    if (instance?.child && instance.child.exitCode === null) {
      const exited = new Promise((resolve) => instance.child.on('exit', resolve));
      instance.child.kill();
      await Promise.race([exited, sleep(5000)]);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

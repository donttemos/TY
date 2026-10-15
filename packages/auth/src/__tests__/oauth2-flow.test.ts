/*
 * @file E-07 认证策略端到端原语单测：OAuth2 授权码流 / apikey 签名 / 外部身份登录
 * @description 覆盖 PRD-010 E-07 验收锚点的框架层：state 一次性消费（防 CSRF/重放）、回调域名
 *   白名单边界（反向验证绕过形态）、未注册提供方拒绝；apikey 强制验签的正反向；loginByOAuth2
 *   的绑定校验与会话签发。fetch 全部用桩，不出网。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/auth
 */

import { describe, expect, it } from 'vitest';
import { BizError } from '@fw/core';
import { MemoryAuthCache } from '../auth-cache.js';
import { OAuth2FlowService, parseOAuth2Providers, parseRedirectWhitelist } from '../oauth2-flow.js';
import { ApiKeyStrategy, apiKeySignature } from '../strategies.js';
import { createHarness } from './test-helpers.js';
import type { OAuth2ProviderConfig } from '../types.js';

/** 标准提供方配置 */
function providerConfig(overrides: Partial<OAuth2ProviderConfig> = {}): OAuth2ProviderConfig {
  return {
    provider: 'demo',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    authorizeUrl: 'https://idp.example.com/authorize',
    tokenUrl: 'https://idp.example.com/token',
    userInfoUrl: 'https://idp.example.com/userinfo',
    ...overrides,
  };
}

/** fetch 桩：记录调用并按 URL 分发响应 */
function fetchStub(routes: { match: (url: string, init?: RequestInit) => boolean; respond: () => { status: number; body: unknown } }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: target, init });
    const route = routes.find((r) => r.match(target, init));
    if (!route) return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
    const { status, body } = route.respond();
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe('parseOAuth2Providers（AUTH_OAUTH2_PROVIDERS 解析）', () => {
  it('空串 = 未启用任何提供方', () => {
    expect(parseOAuth2Providers(undefined)).toEqual([]);
    expect(parseOAuth2Providers('')).toEqual([]);
  });

  it('合法 JSON 解析出配置；缺字段与非法名跳过并保留合法项', () => {
    const raw = JSON.stringify({
      demo: { clientId: 'a', clientSecret: 'b', authorizeUrl: 'u1', tokenUrl: 'u2', userInfoUrl: 'u3' },
      bad: { clientId: 'a' },
      'Bad-Name': { clientId: 'a', clientSecret: 'b', authorizeUrl: 'u', tokenUrl: 'u', userInfoUrl: 'u' },
    });
    const parsed = parseOAuth2Providers(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ provider: 'demo', clientId: 'a', userInfoUrl: 'u3' });
  });

  it('非法 JSON 与非对象形态返回空（不抛错，保持启动可用）', () => {
    expect(parseOAuth2Providers('not-json')).toEqual([]);
    expect(parseOAuth2Providers('[1,2]')).toEqual([]);
  });
});

describe('parseRedirectWhitelist', () => {
  it('逗号分隔、去空、去重', () => {
    expect(parseRedirectWhitelist(' http://a.com , http://b.com,http://a.com ')).toEqual(['http://a.com', 'http://b.com']);
    expect(parseRedirectWhitelist(undefined)).toEqual([]);
  });
});

describe('OAuth2FlowService.buildAuthorizeUrl', () => {
  it('构建跳转地址：携带 client_id / redirect_uri / state，state 已入缓存', async () => {
    const cache = new MemoryAuthCache();
    const flow = new OAuth2FlowService({
      providers: [providerConfig()],
      cache,
      redirectWhitelist: ['http://localhost:5173'],
    });
    const url = new URL(await flow.buildAuthorizeUrl('demo', 'http://localhost:5173/login'));
    expect(url.origin + url.pathname).toBe('https://idp.example.com/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/login');
    const state = url.searchParams.get('state') as string;
    expect(await cache.get(`fw:auth:oauth2:state:${state}`)).toMatchObject({ provider: 'demo', redirectUri: 'http://localhost:5173/login' });
  });

  it('反向验证：提供方未注册 → 3001；redirect_uri 缺失 → 1001', async () => {
    const flow = new OAuth2FlowService({ providers: [], cache: new MemoryAuthCache(), redirectWhitelist: ['http://ok'] });
    await expect(flow.buildAuthorizeUrl('demo', 'http://ok/cb')).rejects.toMatchObject({ code: 3001 });
    const flow2 = new OAuth2FlowService({ providers: [providerConfig()], cache: new MemoryAuthCache(), redirectWhitelist: ['http://ok'] });
    await expect(flow2.buildAuthorizeUrl('demo', undefined)).rejects.toMatchObject({ code: 1001 });
  });

  it('反向验证：回调地址不在白名单 → 1001；白名单为空全拒（默认安全）', async () => {
    const flow = new OAuth2FlowService({ providers: [providerConfig()], cache: new MemoryAuthCache(), redirectWhitelist: ['http://localhost:5173'] });
    await expect(flow.buildAuthorizeUrl('demo', 'http://evil.com/cb')).rejects.toMatchObject({ code: 1001 });
    const open = new OAuth2FlowService({ providers: [providerConfig()], cache: new MemoryAuthCache(), redirectWhitelist: [] });
    await expect(open.buildAuthorizeUrl('demo', 'http://localhost:5173/login')).rejects.toMatchObject({ code: 1001 });
  });

  it('反向验证：前缀绕过形态被拒（白名单 origin 的兄弟域名不命中边界）', async () => {
    const flow = new OAuth2FlowService({ providers: [providerConfig()], cache: new MemoryAuthCache(), redirectWhitelist: ['http://ok.com'] });
    // http://ok.com.evil.com 以 http://ok.com 开头但边界不是 / ? # → 拒绝
    await expect(flow.buildAuthorizeUrl('demo', 'http://ok.com.evil.com/cb')).rejects.toMatchObject({ code: 1001 });
    // 合法边界（路径 / 查询 ? 锚点 #）放行
    await expect(flow.buildAuthorizeUrl('demo', 'http://ok.com/cb')).resolves.toContain('state=');
    await expect(flow.buildAuthorizeUrl('demo', 'http://ok.com')).resolves.toContain('state=');
  });
});

describe('OAuth2FlowService.resolveCallback（state 一次性消费 + code 交换）', () => {
  async function prepare(overrides: { routes?: Parameters<typeof fetchStub>[0]; whitelist?: string[] } = {}) {
    const cache = new MemoryAuthCache();
    const stub = fetchStub(
      overrides.routes ?? [
        { match: (url) => url.includes('/token'), respond: () => ({ status: 200, body: { access_token: 'idp-token', token_type: 'Bearer' } }) },
        { match: (url) => url.includes('/userinfo'), respond: () => ({ status: 200, body: { sub: 'u1', email: 'alice@example.com' } }) },
      ],
    );
    const flow = new OAuth2FlowService({
      providers: [providerConfig(), providerConfig({ provider: 'other', clientId: 'c2', clientSecret: 's2' })],
      cache,
      redirectWhitelist: overrides.whitelist ?? ['http://localhost:5173'],
      fetchImpl: stub.impl,
    });
    const authorizeUrl = new URL(await flow.buildAuthorizeUrl('demo', 'http://localhost:5173/login'));
    return { flow, cache, stub, state: authorizeUrl.searchParams.get('state') as string };
  }

  it('端到端换发：state 校验 → code 换 access_token（form 携带 client 凭据与 redirect_uri）→ 拉用户信息', async () => {
    const { flow, stub, state } = await prepare();
    const result = await flow.resolveCallback('demo', 'the-code', state);
    expect(result).toMatchObject({ provider: 'demo', redirectUri: 'http://localhost:5173/login', idpAccessToken: 'idp-token' });
    expect(result.userInfo).toMatchObject({ sub: 'u1', email: 'alice@example.com' });
    const tokenCall = stub.calls.find((c) => c.url.includes('/token'));
    expect((tokenCall?.init?.body as string)).toContain('grant_type=authorization_code');
    expect((tokenCall?.init?.body as string)).toContain('client_secret=secret-1');
    expect((tokenCall?.init?.body as string)).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Flogin');
    const userinfoCall = stub.calls.find((c) => c.url.includes('/userinfo'));
    expect((userinfoCall?.init?.headers as Record<string, string>).authorization).toBe('Bearer idp-token');
  });

  it('反向验证：state 一次性消费——同一 state 二次回调即拒绝（防重放）', async () => {
    const { flow, state } = await prepare();
    await flow.resolveCallback('demo', 'code', state);
    await expect(flow.resolveCallback('demo', 'code', state)).rejects.toMatchObject({ code: 3001 });
  });

  it('反向验证：伪造 state / provider 与 state 登记不一致 → 3001', async () => {
    const { flow, state } = await prepare();
    await expect(flow.resolveCallback('demo', 'code', 'forged-state')).rejects.toMatchObject({ code: 3001 });
    await expect(flow.resolveCallback('other', 'code', state)).rejects.toMatchObject({ code: 3001 });
  });

  it('反向验证：code 缺失 → 1001；IdP 拒绝令牌交换 → 3001；IdP 不可达 → 9002', async () => {
    const { flow, state } = await prepare();
    await expect(flow.resolveCallback('demo', undefined, state)).rejects.toMatchObject({ code: 1001 });

    const reject = await prepare({
      routes: [{ match: (url) => url.includes('/token'), respond: () => ({ status: 400, body: { error: 'invalid_grant' } }) }],
    });
    await expect(reject.flow.resolveCallback('demo', 'bad-code', reject.state)).rejects.toMatchObject({ code: 3001 });

    const down = await prepare({
      routes: [{ match: (url) => url.includes('/token'), respond: () => { throw new Error('conn refused'); } }],
    });
    await expect(down.flow.resolveCallback('demo', 'code', down.state)).rejects.toMatchObject({ code: 9002 });
  });
});

describe('ApiKeyStrategy 签名模式（E-07）', () => {
  const entries = [{ key: 'k1', subject: 'svc', scopes: ['dict:read'] }];
  const SECRET = 'sign-secret';
  const now = String(Math.floor(Date.now() / 1000));

  it('未配置签名密钥：仅验 key（向后兼容，无需签名头）', async () => {
    const strategy = new ApiKeyStrategy(entries);
    const identity = await strategy.authenticate({ headers: { 'x-api-key': 'k1' } });
    expect(identity).toMatchObject({ kind: 'service', username: 'svc', permissions: ['dict:read'] });
  });

  it('配置签名密钥后：缺签名头 / 时间戳非法 / 超偏差 / 签名不符 → 3001', async () => {
    const strategy = new ApiKeyStrategy(entries, { signSecret: SECRET });
    const req = (headers: Record<string, string>, method = 'GET', path = '/api/v1/dict/user_status') =>
      strategy.authenticate({ headers, method, path });
    await expect(req({ 'x-api-key': 'k1' })).rejects.toMatchObject({ code: 3001 });
    await expect(req({ 'x-api-key': 'k1', 'x-api-timestamp': 'abc' })).rejects.toMatchObject({ code: 3001 });
    await expect(
      req({ 'x-api-key': 'k1', 'x-api-timestamp': String(Number(now) - 3600), 'x-api-sign': '00' }),
    ).rejects.toMatchObject({ code: 3001 });
    await expect(
      req({ 'x-api-key': 'k1', 'x-api-timestamp': now, 'x-api-sign': 'deadbeef' }),
    ).rejects.toMatchObject({ code: 3001 });
  });

  it('正确签名放行；method/path 参与串接（换路径即失效）；apiKeySignature 算法确定性', async () => {
    const strategy = new ApiKeyStrategy(entries, { signSecret: SECRET });
    const path = '/api/v1/dict/user_status';
    const sign = apiKeySignature(SECRET, 'k1', now, 'GET', path);
    const identity = await strategy.authenticate({ headers: { 'x-api-key': 'k1', 'x-api-timestamp': now, 'x-api-sign': sign }, method: 'GET', path });
    expect(identity).toMatchObject({ kind: 'service', via: 'apikey' });

    const otherPathSign = apiKeySignature(SECRET, 'k1', now, 'GET', '/api/v1/users');
    await expect(
      strategy.authenticate({ headers: { 'x-api-key': 'k1', 'x-api-timestamp': now, 'x-api-sign': otherPathSign }, method: 'GET', path }),
    ).rejects.toMatchObject({ code: 3001 });
    // 大写方法等价
    const upper = apiKeySignature(SECRET, 'k1', now, 'get', path);
    await expect(
      strategy.authenticate({ headers: { 'x-api-key': 'k1', 'x-api-timestamp': now, 'x-api-sign': upper }, method: 'GET', path }),
    ).resolves.toMatchObject({ via: 'apikey' });
  });
});

describe('AuthService.loginByOAuth2（E-07 会话落地）', () => {
  it('已绑定本地账号：签发双 token + 审计记录 provider；签发会话与口令登录同源', async () => {
    const h = createHarness();
    await h.seed();
    const result = await h.service.loginByOAuth2({ provider: 'demo', account: 'alice', ip: '10.0.0.9' });
    expect(result.accessToken.length).toBeGreaterThan(20);
    expect(result.refreshToken.length).toBeGreaterThan(20);
    expect(result.user).toMatchObject({ username: 'alice', via: 'jwt' });
    await new Promise((r) => setTimeout(r, 0));
    const page = await h.audit.page({ page: 1, pageSize: 10, module: 'auth', action: 'login' });
    const entry = page.items.find((item) => item.targetId === result.user.id);
    expect(entry?.afterValue).toMatchObject({ provider: 'demo' });
  });

  it('反向验证：未绑定账号 → 3001；禁用账号 → 3004', async () => {
    const h = createHarness();
    await h.seed();
    await expect(h.service.loginByOAuth2({ provider: 'demo', account: 'nobody', ip: '10.0.0.9' })).rejects.toMatchObject({ code: 3001 });
    const alice = await h.store.findUserByAccount('alice');
    await h.store.updateUser(alice!.id, { status: 0 });
    await expect(h.service.loginByOAuth2({ provider: 'demo', account: 'alice', ip: '10.0.0.9' })).rejects.toMatchObject({ code: 3004 });
  });

  it('BizError 实例（全局异常过滤器按统一信封转出）', async () => {
    const h = createHarness();
    await h.seed();
    const err = await h.service.loginByOAuth2({ provider: 'demo', account: 'nobody', ip: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(BizError);
  });
});

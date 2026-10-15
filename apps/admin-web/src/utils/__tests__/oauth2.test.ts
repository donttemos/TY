/*
 * @file OAuth2 登录辅助单测（E-07）
 * @description fragment 解析的正反向（含缺参 / 非数字 expires_in / 无 hash）与授权跳转 URL 构建。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/utils
 */

import { describe, expect, it } from 'vitest';
import { buildOAuth2AuthorizeUrl, parseOAuth2CallbackHash } from '../oauth2';

describe('parseOAuth2CallbackHash', () => {
  it('完整 fragment（含 #）解析出双 token 与 expires_in', () => {
    const parsed = parseOAuth2CallbackHash('#access_token=at-1&refresh_token=rt-1&expires_in=7200');
    expect(parsed).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 });
  });

  it('不含 # 前缀同样可解析', () => {
    expect(parseOAuth2CallbackHash('access_token=a&refresh_token=r')).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: undefined,
    });
  });

  it('反向验证：缺任一令牌 / 无 hash / 空 fragment → null（按非 OAuth2 回调处理）', () => {
    expect(parseOAuth2CallbackHash('#access_token=only-one')).toBeNull();
    expect(parseOAuth2CallbackHash('#refresh_token=r')).toBeNull();
    expect(parseOAuth2CallbackHash('')).toBeNull();
    expect(parseOAuth2CallbackHash('#')).toBeNull();
  });

  it('反向验证：非数字 expires_in 不产生 NaN', () => {
    const parsed = parseOAuth2CallbackHash('#access_token=a&refresh_token=r&expires_in=soon');
    expect(parsed).toMatchObject({ accessToken: 'a', refreshToken: 'r', expiresIn: undefined });
  });
});

describe('buildOAuth2AuthorizeUrl', () => {
  it('拼接 authorize 端点 + redirect_uri（provider 经 encodeURIComponent 防路径注入）', () => {
    expect(buildOAuth2AuthorizeUrl('/api/v1', 'demo', 'http://localhost:5173/login')).toBe(
      '/api/v1/auth/oauth2/demo/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Flogin',
    );
  });
});

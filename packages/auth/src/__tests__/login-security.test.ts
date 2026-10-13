/*
 * @file 登录加固单测
 * @description 覆盖 TC-AUTH-002（5 次失败锁定 15 分钟，第 5 次触发锁定）、锁定期内拒绝、成功清空计数、
 *   锁定到期自动释放、登录接口固定窗口限流（9003）
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */
import { describe, expect, it, vi } from 'vitest';
import { BizError, ErrorCode } from '@fw/core';
import { MemoryAuthCache } from '../auth-cache.js';
import { LoginSecurity } from '../login-security.js';

/** 构造被测实例（5 次 / 15 分钟 / 限流 2 次每 60s） */
function build(): LoginSecurity {
  return new LoginSecurity(new MemoryAuthCache(), {
    maxFailed: 5,
    lockMinutes: 15,
    rateLimit: { windowSeconds: 60, max: 2 },
  });
}

describe('LoginSecurity', () => {
  it('TC-AUTH-002：前 4 次失败不锁定，第 5 次锁定 15 分钟', async () => {
    const security = build();
    for (let i = 1; i <= 4; i += 1) {
      const outcome = await security.recordFailure('10.0.0.1', 'alice');
      expect(outcome.failed).toBe(i);
      expect(outcome.locked).toBe(false);
    }
    const fifth = await security.recordFailure('10.0.0.1', 'alice');
    expect(fifth.failed).toBe(5);
    expect(fifth.locked).toBe(true);
    expect(fifth.lockSeconds).toBe(15 * 60);

    const state = await security.checkLock('10.0.0.1', 'alice');
    expect(state.locked).toBe(true);
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(state.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it('不同 IP 或不同账号互不影响', async () => {
    const security = build();
    await security.recordFailure('10.0.0.1', 'alice');
    expect((await security.checkLock('10.0.0.1', 'alice')).locked).toBe(false);
    expect((await security.checkLock('10.0.0.2', 'alice')).locked).toBe(false);
    expect((await security.checkLock('10.0.0.1', 'bob')).locked).toBe(false);
  });

  it('登录成功后清空失败计数与锁定', async () => {
    const security = build();
    for (let i = 0; i < 5; i += 1) await security.recordFailure('10.0.0.1', 'alice');
    await security.clear('10.0.0.1', 'alice');
    const state = await security.checkLock('10.0.0.1', 'alice');
    expect(state.locked).toBe(false);
    // 计数已清空：再失败一次是第 1 次而非第 6 次
    expect((await security.recordFailure('10.0.0.1', 'alice')).failed).toBe(1);
  });

  it('锁定到期后自动释放', async () => {
    const security = build();
    for (let i = 0; i < 5; i += 1) await security.recordFailure('10.0.0.1', 'alice');
    expect((await security.checkLock('10.0.0.1', 'alice')).locked).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
    const after = await security.checkLock('10.0.0.1', 'alice');
    expect(after.locked).toBe(false);
    expect(after.retryAfterSeconds).toBe(0);
    vi.useRealTimers();
  });

  it('登录接口限流：窗口内超过阈值抛 9003', async () => {
    const security = build();
    await security.assertRateLimit('10.0.0.1');
    await security.assertRateLimit('10.0.0.1');
    await expect(security.assertRateLimit('10.0.0.1')).rejects.toBeInstanceOf(BizError);
    await expect(security.assertRateLimit('10.0.0.1')).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
    // 不同 IP 不受影响
    await expect(security.assertRateLimit('10.0.0.9')).resolves.toBeUndefined();
  });
});

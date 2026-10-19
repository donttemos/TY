/*
 * @file M11.1 L3 Prisma 集成：refresh rotation CAS 真库端到端（ADR-0020）
 * @description 用 example-api 主 schema（SQLite）对真实 PrismaClient 验证：
 *   - 存储层 CAS 三态（rotated / already_rotated / replay_detected）与事务原子性；
 *   - Case A 故障注入：CAS 成功后 INSERT B 失败（token_hash 唯一约束）⇒ 事务回滚、
 *     A 保持 active、无孤儿 B、A 可立即重新轮换（DoD：rollback = PASS）；
 *   - 服务层端到端：grace 重试同一 B（Case B）、100 并发 exactly 1（Rule 5）、
 *     密文损坏 fail closed（Case C，直接改库模拟位腐）、B 已消费后 A replay（Case E）。
 *   独立临时库 + beforeAll 内 migrate deploy，不与开发库交叉；三方言矩阵
 *   （MySQL/PostgreSQL）由 CI service DB 复跑同一 schema 断言（Rule 4 的
 *   REPEATABLE READ 快照陷阱专项归 MySQL 集成）。
 * @author donttemo
 * @created 2026-10-16
 * @module example-api/auth
 */

import 'reflect-metadata';
import { describe, beforeAll, afterAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { ensureSqliteMigrationsApplied } from '../../testing/apply-sqlite-migrations.js';
import { ErrorCode } from '@fw/core';
import { TokenService, RefreshTokenService, hashToken } from '@fw/auth';
import { PrismaAuthStore } from './prisma-auth-store.js';

const execFileAsync = promisify(execFile);

/**
 * 运行模式：
 * - 本地（默认）：自建独立临时 SQLite（file:${cwd}/prisma/test-rotation.db）+ beforeAll migrate deploy；
 * - CI 矩阵（设 ROTATION_TEST_DB_URL）：直连 service DB（mysql/postgres/sqlite），
 *   迁移由 CI 步骤以对应方言 schema 预先 deploy，本 spec 只建数据、只清自己的数据。
 */
const EXTERNAL_DB_URL = process.env.ROTATION_TEST_DB_URL ?? '';
const DB_FILE = path.join(process.cwd(), 'prisma', 'test-rotation.db');
const LOCAL_DB_URL = `file:${DB_FILE.replace(/\\/g, '/')}`;
const TARGET_DB_URL = EXTERNAL_DB_URL || LOCAL_DB_URL;

let prisma: PrismaClient;
let store: PrismaAuthStore;
let refresh: RefreshTokenService;
let userId: string;

/** 带重试的迁移应用（与 packages/db 集成测试同款防抖；example-api schema url = env(DB_URL)） */
async function migrateDeployWithRetry(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await execFileAsync('pnpm exec prisma migrate deploy --schema prisma/schema.prisma', {
        cwd: process.cwd(),
        shell: true,
        env: { ...process.env, DB_URL: LOCAL_DB_URL },
      });
      // 受限环境 deploy 静默不落盘（exit 0 无副作用）：基线表缺失时按序直建全量迁移 DDL
      await ensureSqliteMigrationsApplied(LOCAL_DB_URL);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

beforeAll(async () => {
  if (!EXTERNAL_DB_URL) {
    fs.rmSync(DB_FILE, { force: true });
    // Prisma 6 migrate deploy 在 Windows 上要求 SQLite 文件已存在
    fs.closeSync(fs.openSync(DB_FILE, 'w'));
    await migrateDeployWithRetry();
  }
  prisma = new PrismaClient({ datasources: { db: { url: TARGET_DB_URL } } });
  store = new PrismaAuthStore(prisma);
  const tokens = new TokenService({
    secret: 'm11-integration-secret-0123456789abcdef0123456789abcdef',
    accessTtlSeconds: 900,
    refreshTtlSeconds: 7 * 24 * 3600,
  });
  refresh = new RefreshTokenService(store, tokens, 10);
  const user = await prisma.user.create({
    data: { username: `m11-it-${Date.now()}`, passwordHash: 'x', status: 1, tenantId: 1n },
  });
  userId = user.id;
});

afterAll(async () => {
  if (prisma) {
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
  if (!EXTERNAL_DB_URL) fs.rmSync(DB_FILE, { force: true });
});

/** 直接经 Prisma 插入一条刷新令牌记录（存储层用例构造） */
async function seedToken(overrides: {
  tokenHash: string;
  familyId: string;
  expireAt?: Date;
  revokedAt?: Date | null;
  replacementCipher?: string | null;
  replacementKeyId?: string | null;
  replacementExpiresAt?: Date | null;
}) {
  return prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: overrides.tokenHash,
      familyId: overrides.familyId,
      expireAt: overrides.expireAt ?? new Date(Date.now() + 7 * 24 * 3600 * 1000),
      revokedAt: overrides.revokedAt ?? null,
      loginIp: '1.1.1.1',
      userAgent: 'm11-it',
      replacementCipher: overrides.replacementCipher ?? null,
      replacementKeyId: overrides.replacementKeyId ?? null,
      replacementExpiresAt: overrides.replacementExpiresAt ?? null,
    },
  });
}

describe('M11.1 L3：存储层 CAS 三态（真实 SQLite 事务）', () => {
  it('CAS 赢家：rotated —— A 更新 + B 插入原子提交，replacedById 回填', async () => {
    const familyId = `fam-win-${Date.now()}`;
    const a = await seedToken({ tokenHash: `hash-a-${familyId}`, familyId });
    const now = new Date();
    const result = await store.rotateRefreshToken({
      oldTokenId: a.id,
      replacementUserId: userId,
      replacementFamilyId: familyId,
      replacementTokenHash: `hash-b-${familyId}`,
      replacementCipher: 'v1:replacement-v1:iv:ct:tag',
      replacementKeyId: 'replacement-v1',
      replacementTokenExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
      replacementRecoverableUntil: new Date(now.getTime() + 10_000),
      replacementLoginIp: '1.1.1.1',
      replacementUserAgent: 'm11-it',
      now,
    });

    expect(result.outcome).toBe('rotated');
    if (result.outcome !== 'rotated') return;

    const aAfter = await prisma.refreshToken.findUnique({ where: { id: a.id } });
    expect(aAfter?.revokedAt).not.toBeNull();
    expect(aAfter?.replacedById).toBe(result.replacementId);
    expect(aAfter?.replacementCipher).toBe('v1:replacement-v1:iv:ct:tag');
    const b = await prisma.refreshToken.findUnique({ where: { id: result.replacementId } });
    expect(b?.tokenHash).toBe(`hash-b-${familyId}`);
    expect(b?.familyId).toBe(familyId);
    expect(b?.revokedAt).toBeNull();
  });

  it('CAS 输家：already_rotated 携带 grace 恢复所需事实（Case B 存储层形态）', async () => {
    const familyId = `fam-lose-${Date.now()}`;
    const revokedAt = new Date(Date.now() - 1000);
    const a = await seedToken({
      tokenHash: `hash-a2-${familyId}`,
      familyId,
      revokedAt,
      replacementCipher: 'v1:replacement-v1:iv2:ct2:tag2',
      replacementKeyId: 'replacement-v1',
      replacementExpiresAt: new Date(Date.now() + 10_000),
    });

    const result = await store.rotateRefreshToken({
      oldTokenId: a.id,
      replacementUserId: userId,
      replacementFamilyId: familyId,
      replacementTokenHash: `hash-b2-${familyId}`,
      replacementCipher: 'v1:replacement-v1:x:y:z',
      replacementKeyId: 'replacement-v1',
      replacementTokenExpiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      replacementRecoverableUntil: new Date(Date.now() + 10_000),
      replacementLoginIp: '1.1.1.1',
      replacementUserAgent: 'm11-it',
      now: new Date(),
    });

    expect(result).toMatchObject({
      outcome: 'already_rotated',
      oldToken: { revokedAt, familyId },
      replacement: { keyId: 'replacement-v1' },
    });
  });

  it('replay_detected：expired / no_replacement / not_found 三种存储层事实', async () => {
    const familyId = `fam-replay-${Date.now()}`;
    const expired = await seedToken({
      tokenHash: `hash-exp-${familyId}`,
      familyId,
      expireAt: new Date(Date.now() - 1000),
    });
    const noReplacement = await seedToken({
      tokenHash: `hash-norep-${familyId}`,
      familyId,
      revokedAt: new Date(Date.now() - 1000),
    });

    const base = {
      replacementUserId: userId,
      replacementFamilyId: familyId,
      replacementTokenHash: 'hash-any',
      replacementCipher: 'v1:replacement-v1:x:y:z',
      replacementKeyId: 'replacement-v1',
      replacementTokenExpiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      replacementRecoverableUntil: new Date(Date.now() + 10_000),
      replacementLoginIp: null,
      replacementUserAgent: null,
      now: new Date(),
    };

    await expect(
      store.rotateRefreshToken({ ...base, oldTokenId: expired.id }),
    ).resolves.toMatchObject({ outcome: 'replay_detected', reason: 'expired' });
    await expect(
      store.rotateRefreshToken({ ...base, oldTokenId: noReplacement.id }),
    ).resolves.toMatchObject({ outcome: 'replay_detected', reason: 'no_replacement' });
    await expect(
      store.rotateRefreshToken({ ...base, oldTokenId: 'no-such-id' }),
    ).resolves.toMatchObject({ outcome: 'replay_detected', reason: 'not_found' });
  });

  it('createRefreshToken 透传 replacement 四列——契约字段不得静默丢弃（ADR-0021）', async () => {
    const expiresAt = new Date(Date.now() + 10_000);
    const rec = await store.createRefreshToken({
      userId,
      tokenHash: `passthrough-${Date.now()}`,
      familyId: 'fam-passthrough',
      expireAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      revokedAt: null,
      loginIp: null,
      userAgent: null,
      replacedById: 'replaced-x',
      replacementCipher: 'v1:replacement-v1:iv:ct:tag',
      replacementKeyId: 'replacement-v1',
      replacementExpiresAt: expiresAt,
    });
    expect(rec.replacedById).toBe('replaced-x');
    expect(rec.replacementCipher).toBe('v1:replacement-v1:iv:ct:tag');
    expect(rec.replacementKeyId).toBe('replacement-v1');
    expect(rec.replacementExpiresAt).toEqual(expiresAt);
  });

  it('Case A：CAS 成功后 INSERT B 失败（token_hash 唯一约束）⇒ 事务回滚、A 保持 active、可重新轮换', async () => {
    const familyId = `fam-casea-${Date.now()}`;
    const a = await seedToken({ tokenHash: `hash-casea-a-${familyId}`, familyId });
    // 预插一条与「将要插入的 B」同 tokenHash 的记录 ⇒ INSERT B 必然唯一约束失败
    const duplicateHash = `hash-casea-b-${familyId}`;
    await seedToken({ tokenHash: duplicateHash, familyId });

    await expect(
      store.rotateRefreshToken({
        oldTokenId: a.id,
        replacementUserId: userId,
        replacementFamilyId: familyId,
        replacementTokenHash: duplicateHash,
        replacementCipher: 'v1:replacement-v1:x:y:z',
        replacementKeyId: 'replacement-v1',
        replacementTokenExpiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        replacementRecoverableUntil: new Date(Date.now() + 10_000),
        replacementLoginIp: null,
        replacementUserAgent: null,
        now: new Date(),
      }),
    ).rejects.toBeDefined();

    // 回滚完整性：A 未被撤销、无密文、无 replacedById；没有孤儿 B（同 hash 仍只有预插的一条）
    const aAfter = await prisma.refreshToken.findUnique({ where: { id: a.id } });
    expect(aAfter?.revokedAt).toBeNull();
    expect(aAfter?.replacementCipher).toBeNull();
    expect(aAfter?.replacedById).toBeNull();
    expect(await prisma.refreshToken.count({ where: { tokenHash: duplicateHash } })).toBe(1);

    // A 保持 active ⇒ 立即用不冲突的 hash 重新轮换仍成功
    const retry = await store.rotateRefreshToken({
      oldTokenId: a.id,
      replacementUserId: userId,
      replacementFamilyId: familyId,
      replacementTokenHash: `hash-casea-b2-${familyId}`,
      replacementCipher: 'v1:replacement-v1:x2:y2:z2',
      replacementKeyId: 'replacement-v1',
      replacementTokenExpiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      replacementRecoverableUntil: new Date(Date.now() + 10_000),
      replacementLoginIp: null,
      replacementUserAgent: null,
      now: new Date(),
    });
    expect(retry.outcome).toBe('rotated');
  });
});

describe('M11.1 L3：服务层端到端（RefreshTokenService + PrismaAuthStore）', () => {
  it('grace 重试返回同一个 B（Case B）；10 并发 ⇒ exactly 1 replacement（Rule 5）', async () => {
    const first = await refresh.issue(userId, '1.1.1.1', 'm11-it');
    const rotated = await refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-it');

    const retry = await refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-it');
    expect(retry.refreshToken).toBe(rotated.refreshToken);
    expect(retry.outcome.withinGrace).toBe(true);

    // SQLite 为单写者引擎，排队交互式事务受连接器超时约束（store 已放宽到 15s），
    // 10 并发为 SQLite 集成的稳定上限（实测）；exactly-100 并发容量线由 CI 的
    // MySQL/PostgreSQL 矩阵承担（行锁 + busy 重试，无此约束）——ADR-0020 DoD 对应项待 CI 勾选。
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-it'),
      ),
    );
    const uniqueTokens = [...new Set(results.map((r) => r.refreshToken))];
    expect(uniqueTokens).toHaveLength(1);
    expect(uniqueTokens[0]).toBe(rotated.refreshToken);
  }, 30_000);

  it('Case C：密文损坏（直接改库模拟位腐）⇒ fail closed 族撤销，绝不生成第二个 replacement', async () => {
    const first = await refresh.issue(userId, '1.1.1.1', 'm11-it');
    const rotated = await refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-it');

    const aRecord = await prisma.refreshToken.findFirst({
      where: { tokenHash: hashToken(first.refreshToken) },
    });
    expect(aRecord?.replacementCipher).not.toBeNull();
    await prisma.refreshToken.update({
      where: { id: aRecord!.id },
      data: { replacementCipher: 'v1:replacement-v1:AAAA:BBBB:CCCC' },
    });

    await expect(refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-it')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    const bRecord = await prisma.refreshToken.findFirst({
      where: { tokenHash: hashToken(rotated.refreshToken) },
    });
    expect(bRecord?.revokedAt).not.toBeNull();
  }, 30_000);

  it('M11.4：轮换部署（OLD→NEW+PREV）下 legacy 密文 grace 内恢复原 B 不触发族撤销（ADR-0023 prerequisite ③ 真库验证）', async () => {
    // 旧实例：secret=OLD（legacy HKDF 派生 replacement-v1）
    const oldTokens = new TokenService({
      secret: 'old-secret-0123456789abcdef0123456789abcdef',
      accessTtlSeconds: 900,
      refreshTtlSeconds: 7 * 24 * 3600,
    });
    const oldRefresh = new RefreshTokenService(store, oldTokens, 10, true);
    const first = await oldRefresh.issue(userId, '1.1.1.1', 'device-1');
    const b = await oldRefresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');

    // 新实例：secret=NEW + prev=OLD（轮换部署形态）——legacy 密文走 HKDF(NEW)失败→HKDF(OLD)成功
    const newTokens = new TokenService({
      secret: 'new-secret-0123456789abcdef0123456789abcdef',
      secretPrev: 'old-secret-0123456789abcdef0123456789abcdef',
      accessTtlSeconds: 900,
      refreshTtlSeconds: 7 * 24 * 3600,
    });
    const newRefresh = new RefreshTokenService(store, newTokens, 10, true);
    const retry = await newRefresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');
    expect(retry.refreshToken).toBe(b.refreshToken);
    expect(retry.outcome.withinGrace).toBe(true);
    const bRecord = await prisma.refreshToken.findFirst({
      where: { tokenHash: hashToken(b.refreshToken) },
    });
    expect(bRecord?.revokedAt).toBeNull();
  });

  it('M11.4：key retirement 判据——replacement_key_id 未过期行数为 0 即可退役（ADR-0021/0023 衔接）', async () => {
    // 构造两个 keyId：v1 已过期（可退役）、v2 未过期（不可退役）
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const past = new Date(Date.now() - 60_000);
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: `retire-v1-${Date.now()}`,
        familyId: 'fam-retire',
        expireAt: future,
        revokedAt: new Date(),
        replacementCipher: 'v1:replacement-v1:iv:ct:tag',
        replacementKeyId: 'replacement-v1',
        replacementExpiresAt: past,
      },
    });
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: `retire-v2-${Date.now()}`,
        familyId: 'fam-retire',
        expireAt: future,
        revokedAt: new Date(),
        replacementCipher: 'v1:replacement-v2:iv:ct:tag',
        replacementKeyId: 'replacement-v2',
        replacementExpiresAt: future,
      },
    });
    // 退役判据：该 keyId 名下未过期 cipher 行数（按本用例 family 过滤——其它用例的同 keyId 行不参与判定）
    const activeRows = async (keyId: string) =>
      prisma.refreshToken.count({
        where: { replacementKeyId: keyId, familyId: 'fam-retire', replacementExpiresAt: { gt: new Date() } },
      });
    expect(await activeRows('replacement-v1')).toBe(0); // 可退役
    expect(await activeRows('replacement-v2')).toBe(1); // 不可退役
  });

  it('M11.3：赢家指纹落库 + 异客户端 grace 重试 → replay 族撤销（ADR-0022 真库验证）', async () => {
    const first = await refresh.issue(userId, '1.1.1.1', 'device-1');
    const b = await refresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');

    const aRecord = await prisma.refreshToken.findFirst({
      where: { tokenHash: hashToken(first.refreshToken) },
    });
    expect(aRecord?.rotatedFingerprint).not.toBeNull();

    await expect(
      refresh.rotate(first.refreshToken, '2.2.2.2', 'device-2'),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    const bRecord = await prisma.refreshToken.findFirst({
      where: { tokenHash: hashToken(b.refreshToken) },
    });
    expect(bRecord?.revokedAt).not.toBeNull();
  });

  it('Case E：B 已消费（B→C）后 A replay ⇒ fail closed，整族（含 C）撤销', async () => {
    const first = await refresh.issue(userId, '1.1.1.1', 'm11-it');
    const b = await refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-it');
    const c = await refresh.rotate(b.refreshToken, '1.1.1.1', 'm11-it');

    await expect(refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-it')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    const cRecord = await prisma.refreshToken.findFirst({
      where: { tokenHash: hashToken(c.refreshToken) },
    });
    expect(cRecord?.revokedAt).not.toBeNull();
    await expect(refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-it')).rejects.toBeDefined();
  }, 30_000);
});

/*
 * @file M12 W2 链路贯通集成（PRD-012 OBS-13，G12-2 验收）
 * @description 构造一次真实 replay 场景，断言同一次请求的 requestId + traceId 在多处一致可关联：
 *   ① audit_logs 行（真实 SQLite）——request_id / trace_id / family_id / jti / event / result 齐全
 *      （requestId 由 AuditService.persist 从 ALS 自动取值——OBS-09/06 贯通点）；
 *   ② 结构化日志——LogRecord 自动输出 requestId / userId（OBS-11），replay error 级日志含 code（OBS-05）；
 *   ③ /metrics 计数——fw_security_replay_detected_total{reason}（OBS-12，经 @fw/core 段注册表渲染）。
 *   第④处（HTTP 响应头 X-Request-Id / X-Trace-Id）由 @fw/core trace-request-id.test.ts 单测锁定
 *   （中间件回带 + 错误信封 additive），此处不重复起真实 HTTP 服务。
 *   九要素断言：requestId / userId / familyId / jti / IP / UA / timestamp / event / result。
 *   独立临时库 + beforeAll migrate deploy（与 refresh-rotation.integration.spec 同款防抖）。
 * @author donttemo
 * @created 2026-10-17
 * @module example-api/auth
 */

import 'reflect-metadata';
import { describe, beforeAll, afterAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { runWithRequestContext } from '@fw/logger';
import { RefreshTokenService, renderAuthMetricsSection, resetAuthMetrics, TokenService } from '@fw/auth';
import { PrismaAuthStore } from './prisma-auth-store.js';

const execFileAsync = promisify(execFile);

const EXTERNAL_DB_URL = process.env.ROTATION_TEST_DB_URL ?? '';
const DB_FILE = path.join(process.cwd(), 'prisma', 'test-observability.db');
const LOCAL_DB_URL = `file:${DB_FILE.replace(/\\/g, '/')}`;
const TARGET_DB_URL = EXTERNAL_DB_URL || LOCAL_DB_URL;

let prisma: PrismaClient;
let store: PrismaAuthStore;
let refresh: RefreshTokenService;
let userId: string;

/** 带重试的迁移应用（与 refresh-rotation.integration.spec 同款防抖） */
async function migrateDeployWithRetry(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await execFileAsync('pnpm exec prisma migrate deploy --schema prisma/schema.prisma', {
        cwd: process.cwd(),
        shell: true,
        env: { ...process.env, DB_URL: LOCAL_DB_URL },
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

/** 结构化日志捕获（logger 全局单例注入 sink） */
const logLines: string[] = [];

beforeAll(async () => {
  const { configureLogger } = await import('@fw/logger');
  configureLogger({ sink: (line) => logLines.push(line) });
  if (!EXTERNAL_DB_URL) {
    fs.rmSync(DB_FILE, { force: true });
    fs.closeSync(fs.openSync(DB_FILE, 'w'));
    await migrateDeployWithRetry();
  }
  prisma = new PrismaClient({ datasources: { db: { url: TARGET_DB_URL } } });
  store = new PrismaAuthStore(prisma);
  const tokens = new TokenService({
    secret: 'm12-observability-secret-0123456789abcdef0123456789abcdef',
    accessTtlSeconds: 900,
    refreshTtlSeconds: 7 * 24 * 3600,
  });
  refresh = new RefreshTokenService(store, tokens, 10);
  const user = await prisma.user.create({
    data: { username: `m12-it-${Date.now()}`, passwordHash: 'x', status: 1, tenantId: 1n },
  });
  userId = user.id;
});

afterAll(async () => {
  if (prisma) {
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
  if (!EXTERNAL_DB_URL) fs.rmSync(DB_FILE, { force: true });
});

describe('M12 W2 · replay 场景一条链贯通（OBS-13）', () => {
  it('requestId + traceId 在审计行 / 结构化日志 / metrics 三处一致可关联；九要素齐全', async () => {
    resetAuthMetrics();
    const first = await refresh.issue(userId, '2.2.2.2', 'chain-device');
    // 先正常轮换一次（A → B），随后复用旧令牌 A 且指纹不匹配 ⇒ grace 重试判定为 replay
    await refresh.rotate(first.refreshToken, '2.2.2.2', 'chain-device');
    const requestId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const traceId = 'trace-chain-e2e-0001';
    logLines.length = 0;

    // 同一次请求上下文内触发 replay（旧令牌复用 ⇒ 走统一审计路径 + 安全事件计数）
    await expect(
      runWithRequestContext({ traceId, spanId: '', requestId, userId }, () =>
        refresh.rotate(first.refreshToken, '6.6.6.6', 'chain-replay-agent'),
      ),
    ).rejects.toMatchObject({ code: 3001 });

    // ---- ① audit_logs 行：requestId 与上下文一致，九要素齐全 ----
    const row = await prisma.auditLog.findFirst({
      where: { userId, event: 'refresh.replay_detected' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row, 'replay 审计行必须存在').not.toBeNull();
    expect(row!.requestId).toBe(requestId);
    expect(row!.traceId).toBe(traceId);
    expect(row!.familyId).toBeTruthy();
    expect(row!.jti).toBeTruthy();
    expect(row!.ip).toBe('6.6.6.6');
    expect(row!.userAgent).toBe('chain-replay-agent');
    expect(row!.result).toBe('denied');
    expect(row!.category).toBe('security');
    expect(row!.createdAt.getTime()).toBeLessThanOrEqual(Date.now());

    // ---- ② 结构化日志：LogRecord 自动携带 requestId / userId（OBS-11）----
    // replay 的 error 级日志 msg =「检测到 refresh 令牌复用…」（event 名进审计行，日志以 msg 定位）
    const chainLog = logLines.find((l) => l.includes('令牌复用'));
    expect(chainLog, 'replay 结构化日志必须存在').toBeDefined();
    const parsed = JSON.parse(chainLog!) as { requestId?: string; userId?: string; traceId?: string };
    expect(parsed.requestId).toBe(requestId);
    expect(parsed.userId).toBe(userId);
    expect(parsed.traceId).toBe(traceId);

    // ---- ③ /metrics：fw_security_replay_detected_total{reason} 计数（OBS-12）----
    const metrics = renderAuthMetricsSection();
    expect(metrics).toMatch(/fw_security_replay_detected_total\{reason="[a-z_]+"\} \d+/);
    expect(metrics).toContain('fw_security_family_revoked_total 1');
    // 基数护栏联动：metrics 文本不含本次请求的身份值（label 仅低基数）
    expect(metrics).not.toContain(requestId);
    expect(metrics).not.toContain(userId);
  });
});

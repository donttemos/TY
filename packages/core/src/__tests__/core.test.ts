/*
 * @file @fw/core 单元测试
 * @description 覆盖错误码表、BizError、ResponseInterceptor、GlobalExceptionFilter、HealthController、GracefulShutdown；e2e 用 supertest 验证统一响应 + traceId 贯通（TC-CORE-003/004/006/007）
 * @author donttemo
 * @created 2026-10-12
 * @modified 2026-10-13 donttemo vite 8/vitest 4 覆盖率统计更精后补齐真实缺口：停机超时强退、关闭钩子异常、stdout drain、默认 process.exit、信号注册与重复信号
 * @modified 2026-10-13 donttemo vite 8/vitest 4 覆盖率统计更精后补齐真实缺口：停机超时强退、关闭钩子异常、stdout drain、默认 process.exit、信号注册与重复信号
 * @since v0.1.0
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { getRequestContext } from '@fw/logger';
import request from 'supertest';
import { BadRequestException, Controller, Get, Module, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ErrorCode,
  ERROR_CODE_META,
  BizError,
  ResponseInterceptor,
  GlobalExceptionFilter,
  HealthController,
  READINESS_PROBES,
  FwCoreModule,
  setupGracefulShutdown,
  runGracefulShutdown,
  traceMiddleware,
} from '../index.js';

/** 临时目录 + .env，便于 FwCoreModule.forRoot 校验通过 */
function makeCwd(): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-core-'));
  // APP_PORT 仅用于非测试场景（实际未 listen）；supertest 走 in-memory http server 不需要真实端口
  fs.writeFileSync(path.join(dir, '.env'), 'APP_ENV=dev\nAPP_PORT=3000\n');
  const prev = process.cwd();
  const envBackup = { ...process.env };
  process.chdir(dir);
  return {
    dir,
    restore: () => {
      process.chdir(prev);
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, envBackup);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('@fw/core · 错误码表', () => {
  it('每条错误码都有 HTTP 状态与默认中文文案', () => {
    expect(ERROR_CODE_META[ErrorCode.OK]).toBeUndefined();
    expect(ERROR_CODE_META[ErrorCode.BAD_REQUEST].http).toBe(400);
    expect(ERROR_CODE_META[ErrorCode.INTERNAL].http).toBe(500);
    expect(ERROR_CODE_META[ErrorCode.RATE_LIMITED].http).toBe(429);
  });
});

describe('@fw/core · BizError', () => {
  it('默认文案与 HTTP 状态取自错误码表', () => {
    const err = new BizError(ErrorCode.NOT_FOUND);
    expect(err.code).toBe(1002);
    expect(err.http).toBe(404);
    expect(err.message).toBe('资源不存在');
  });

  it('支持自定义文案与字段级 details', () => {
    const err = new BizError(ErrorCode.BAD_REQUEST, '用户名不合法', [
      { field: 'username', message: '长度需为 3-32' },
    ]);
    expect(err.message).toBe('用户名不合法');
    expect(err.details).toEqual([{ field: 'username', message: '长度需为 3-32' }]);
  });
});

/** 业务演示控制器（用 BizError 触发全局过滤器） */
@Controller('/api/v1/test')
class TestController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }
  @Get('biz')
  biz(): never {
    throw new BizError(ErrorCode.BIZ_FAILED, '库存不足');
  }
  @Get('boom')
  boom(): never {
    throw new Error('意外');
  }
  @Get('bad-request')
  badRequest(): never {
    // Nest 默认把校验错误转成 BadRequestException 且 message 为字符串数组
    throw new BadRequestException(['username must be 3-32 chars']);
  }
  @Get('tenant')
  tenant(): { tenantId?: string } {
    return { tenantId: getRequestContext()?.tenantId };
  }
}

@Module({ controllers: [TestController] })
class TestModule {}

describe('@fw/core · 全局过滤器 + 统一响应（TC-CORE-004）', () => {
  let ctx: { dir: string; restore: () => void };
  let app: INestApplication;

  beforeEach(async () => {
    ctx = makeCwd();
    const moduleRef = await Test.createTestingModule({ imports: [FwCoreModule.forRoot(), TestModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(traceMiddleware);
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
    ctx.restore();
  });

  it('正常响应：code=0 + traceId 字段', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test/ok');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.message).toBe('ok');
    expect(res.body.data).toEqual({ ok: true });
    expect(typeof res.body.traceId).toBe('string');
  });

  it('BizError：2001 + 自定义文案', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test/biz');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(2001);
    expect(res.body.message).toBe('库存不足');
    expect(res.body.data).toBeNull();
    expect(res.body.traceId).toBeDefined();
  });

  it('未知异常收敛为 9001，message 不泄漏内部细节', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe(9001);
    expect(res.body.message).toBe('系统内部错误');
    expect(res.body.data).toBeNull();
  });

  it('Nest BadRequestException（数组 message）映射到 1001 + details', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test/bad-request');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(1001);
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details[0].message).toContain('username must be 3-32');
  });

  it('404 路由映射到 1002', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/no-such');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(1002);
  });
});

describe('@fw/core · /health 与 /ready（TC-CORE-006）', () => {
  let ctx: { dir: string; restore: () => void };
  let app: INestApplication;

  beforeEach(async () => {
    ctx = makeCwd();
    // 注册一个失败探针，验证 503 路径
    const moduleRef = await Test.createTestingModule({
      imports: [FwCoreModule.forRoot({ readinessProbes: [{ name: 'db', check: async () => false }] })],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(traceMiddleware);
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
    ctx.restore();
  });

  it('/health 返回 200 + 状态 ok（不走统一响应包装）', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
  });

  it('/ready 任一探针失败返回 503（不进统一响应包装）', async () => {
    const res = await request(app.getHttpServer()).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('fail');
    expect(res.body.checks).toEqual({ db: 'fail' });
  });
});

describe('@fw/core · traceId 透传', () => {
  let ctx: { dir: string; restore: () => void };
  let app: INestApplication;

  beforeEach(async () => {
    ctx = makeCwd();
    const moduleRef = await Test.createTestingModule({ imports: [FwCoreModule.forRoot(), TestModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(traceMiddleware);
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
    ctx.restore();
  });

  it('上游 X-Trace-Id 合规时直接透传，不合规时服务端生成', async () => {
    // 合规：8+ 长度 hex 字符串
    const valid = 'aabbccdd00112233aabbccdd00112233';
    const res1 = await request(app.getHttpServer())
      .get('/api/v1/test/ok')
      .set('X-Trace-Id', valid);
    expect(res1.headers['x-trace-id']).toBe(valid);
    expect(res1.body.traceId).toBe(valid);

    // 不合规（短于 8）：服务端生成新 traceId
    const res2 = await request(app.getHttpServer())
      .get('/api/v1/test/ok')
      .set('X-Trace-Id', 'x');
    expect(res2.headers['x-trace-id']).not.toBe('x');
    expect(res2.body.traceId).toBe(res2.headers['x-trace-id']);
  });

  it('X-Tenant-Id 写入请求异步上下文，无效值不注入', async () => {
    const valid = await request(app.getHttpServer()).get('/api/v1/test/tenant').set('X-Tenant-Id', '17');
    expect(valid.body.data).toEqual({ tenantId: '17' });
    const invalid = await request(app.getHttpServer()).get('/api/v1/test/tenant').set('X-Tenant-Id', '0 or 1=1');
    expect(invalid.body.data).toEqual({});
  });
});

describe('@fw/core · 优雅停机（TC-CORE-007）', () => {
  /**
   * 构造停机上下文。`autoClose: false` 时 server.close 的回调挂起不触发，用于模拟「在途请求尚未结束」，
   * 由用例调用 releasePending() 收尾（避免留下悬挂的 await）。
   */
  function makeShutdownCtx(options: { closeHookFails?: boolean; autoClose?: boolean } = {}) {
    const appClose = options.closeHookFails
      ? vi.fn().mockRejectedValue(new Error('pool close failed'))
      : vi.fn().mockResolvedValue(undefined);
    const app = { close: appClose } as unknown as INestApplication;
    const server = new EventEmitter() as unknown as Server;
    const pending: (() => void)[] = [];
    const serverClose = vi.fn((cb?: () => void) => {
      if (!cb) return;
      if (options.autoClose === false) pending.push(cb);
      else setImmediate(cb);
    });
    Object.assign(server, { close: serverClose, closeIdleConnections: vi.fn() });

    const logLines: string[] = [];
    const logger = {
      info: (msg: string) => logLines.push(msg),
      error: (msg: string) => logLines.push(`ERROR ${msg}`),
    };
    const exit = vi.fn();

    return {
      app,
      appClose,
      server: server as Server,
      serverClose,
      logLines,
      exit,
      base: { app, server: server as Server, timeoutSeconds: 5, logger: logger as never, exit },
      releasePending: () => {
        for (const cb of pending) cb();
      },
    };
  }

  it('收到 SIGTERM 后调用 app.close 并打印 shutdown complete', async () => {
    const ctx = makeShutdownCtx();

    await runGracefulShutdown(ctx.base, 'SIGTERM');

    expect(ctx.serverClose).toHaveBeenCalled();
    expect(ctx.appClose).toHaveBeenCalled();
    expect(ctx.logLines.some((l) => l.includes('开始优雅停机'))).toBe(true);
    expect(ctx.logLines).toContain('shutdown complete');
    expect(ctx.exit).toHaveBeenCalledWith(0);
  });

  it('在途请求超时未完成时先强制退出(1)，请求结束后仍走完正常退出(0)', async () => {
    const ctx = makeShutdownCtx({ autoClose: false });

    const running = runGracefulShutdown({ ...ctx.base, timeoutSeconds: 0.02 }, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(ctx.logLines.some((l) => l.includes('优雅停机超时'))).toBe(true);
    expect(ctx.exit).toHaveBeenNthCalledWith(1, 1);

    ctx.releasePending();
    await running;
    expect(ctx.exit).toHaveBeenLastCalledWith(0);
  });

  it('关闭钩子抛错时记录错误但不阻断退出', async () => {
    const ctx = makeShutdownCtx({ closeHookFails: true });

    await runGracefulShutdown(ctx.base, 'SIGTERM');

    expect(ctx.logLines.some((l) => l.includes('关闭钩子执行失败'))).toBe(true);
    expect(ctx.exit).toHaveBeenCalledWith(0);
  });

  it('stdout 有未落盘数据时等待 drain 事件再退出', async () => {
    const ctx = makeShutdownCtx();
    // 假装 stdout 仍有积压字节：真实环境走的是 else 分支（等 drain），此处显式构造
    Object.defineProperty(process.stdout, 'writableLength', { configurable: true, get: () => 1024 });
    try {
      const running = runGracefulShutdown(ctx.base, 'SIGTERM');
      await new Promise((resolve) => setImmediate(resolve));
      process.stdout.emit('drain');
      await running;
      expect(ctx.exit).toHaveBeenCalledWith(0);
    } finally {
      delete (process.stdout as unknown as Record<string, unknown>).writableLength;
    }
  });

  it('未注入 exit 时走默认 process.exit', async () => {
    const ctx = makeShutdownCtx();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await runGracefulShutdown(
        { app: ctx.app, server: ctx.server, timeoutSeconds: 5, logger: ctx.base.logger },
        'SIGTERM',
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('setupGracefulShutdown 注册信号处理，重复信号只停机一次', async () => {
    const ctx = makeShutdownCtx();
    setupGracefulShutdown(ctx.base);

    process.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    // 第二次信号应被 shuttingDown 守卫忽略（不重复执行 app.close）
    process.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ctx.appClose).toHaveBeenCalledTimes(1);
    expect(ctx.exit).toHaveBeenCalledTimes(1);
    expect(ctx.exit).toHaveBeenCalledWith(0);
  });
});

/*
 * @file Studio 服务单测（PRD-017 铁律 5 / AC-17-07）
 * @description 用真实 HTTP 请求验证边界（不用假 server）：token 鉴权、Host 与 Origin 校验、
 *   只允许 GET、未知路径 404、页面可访问。这些是「本地服务不会变成任意操作接口」的实证。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildGenArgs,
  startStudioServer,
  type StudioServerHandle,
  buildReviewArgs,
} from '../server.js';

let tmpDir: string;
let handle: StudioServerHandle | null = null;

/** 发一个真实 HTTP 请求（需要能自定 Host 头，故不用 fetch） */
function request(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-studio-server-'));
  const backend = path.join(tmpDir, 'apps', 'example-api');
  fs.mkdirSync(path.join(backend, 'prisma'), { recursive: true });
  fs.writeFileSync(
    path.join(backend, 'prisma', 'schema.prisma'),
    // 两个模型：关系用例需要「另一端」
    'model Product {\n  id   String @id\n  name String\n}\n\nmodel Category {\n  id   String @id\n  name String\n}\n',
    'utf8',
  );
  fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
  // skipValidate：单测不跑真实 prisma validate（写回内核已有专门用例覆盖）
  handle = await startStudioServer({
    projectRoot: tmpDir,
    port: 0,
    token: 'test-token',
    log: () => undefined,
    skipValidate: true,
    // 指向不存在的目录：本组用例验证「前端未构建时的内置只读页」
    webDist: path.join(tmpDir, 'no-web-dist'),
    aiConfigFile: path.join(tmpDir, 'ai-config.json'),
  });
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Studio 服务边界', () => {
  it('只监听 127.0.0.1，访问地址带一次性 token', () => {
    expect(handle?.url).toContain('127.0.0.1');
    expect(handle?.url).toContain('token=test-token');
    expect(handle?.port).toBeGreaterThan(0);
  });

  it('首页可访问，且带安全响应头', async () => {
    const response = await request({ port: handle!.port, path: '/' });
    expect(response.status).toBe(200);
    expect(response.body).toContain('TY Studio');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('无 token 访问 API 被拒（401）', async () => {
    const response = await request({ port: handle!.port, path: '/api/project' });
    expect(response.status).toBe(401);
    expect(response.body).toContain('unauthorized');
  });

  it('错误 token 被拒（401）', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/project',
      headers: { 'x-studio-token': 'wrong' },
    });
    expect(response.status).toBe(401);
  });

  it('正确 token 返回体检数据', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/project',
      headers: { 'x-studio-token': 'test-token' },
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.root).toBe(tmpDir);
    expect(data.schema.models.map((model: { name: string }) => model.name)).toEqual(['Product', 'Category']);
    expect(Array.isArray(data.environment)).toBe(true);
  });

  it('token 也可经查询参数传递（便于浏览器直接打开）', async () => {
    const response = await request({ port: handle!.port, path: '/api/health?token=test-token' });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).ok).toBe(true);
  });

  it('非本机 Host 被拒（防 DNS rebinding）', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/project',
      headers: { host: 'evil.example.com', 'x-studio-token': 'test-token' },
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain('forbidden-host');
  });

  it('跨站 Origin 被拒（防跨站读取）', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/project',
      headers: { origin: 'http://evil.example.com', 'x-studio-token': 'test-token' },
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain('forbidden-origin');
  });

  it('同源 Origin 放行', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/project',
      headers: { origin: `http://127.0.0.1:${handle!.port}`, 'x-studio-token': 'test-token' },
    });
    expect(response.status).toBe(200);
  });

  it('写方法一律被拒（S1 只读）', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/project',
      method: 'POST',
      headers: { 'x-studio-token': 'test-token' },
    });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET, HEAD');
  });

  it('未知路径返回 404（不做文件服务）', async () => {
    const response = await request({
      port: handle!.port,
      path: '/../../etc/passwd',
      headers: { 'x-studio-token': 'test-token' },
    });
    expect(response.status).toBe(404);
  });

  it('关闭后端口不再可用', async () => {
    const port = handle!.port;
    await handle!.close();
    handle = null;
    await expect(request({ port, path: '/' })).rejects.toThrow();
  });
});

describe('Studio schema 写接口（S2）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };
  const schemaFile = (): string => path.join(tmpDir, 'apps', 'example-api', 'prisma', 'schema.prisma');

  it('GET /api/schema 返回模型与字段', async () => {
    const response = await request({ port: handle!.port, path: '/api/schema', headers: auth });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.exists).toBe(true);
    expect(data.models[0].name).toBe('Product');
    expect(data.models[0].fields.map((field: { name: string }) => field.name)).toEqual(['id', 'name']);
  });

  it('preview 安全变更：不签发令牌，返回 diff', async () => {
    const edits = [
      { model: 'Product', fields: [{ name: 'id', type: 'String', optional: false, isList: false, attrs: '@id' }] },
    ];
    // 删字段属于阻断级；先用「新增可空字段」验证安全路径
    const safeEdits = [
      {
        model: 'Product',
        fields: [
          { name: 'id', type: 'String', optional: false, isList: false, attrs: '@id' },
          { name: 'name', type: 'String', optional: false, isList: false, attrs: '' },
          { name: 'remark', type: 'String', optional: true, isList: false, attrs: '' },
        ],
      },
    ];
    const response = await request({
      port: handle!.port,
      path: '/api/schema/preview',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ edits: safeEdits }),
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.assessment.risk).toBe('safe');
    expect(data.confirmToken).toBeUndefined();
    expect(data.diff).toContain('+   remark');
    expect(edits.length).toBe(1);
  });

  it('preview 删字段：判定阻断并签发确认令牌', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/schema/preview',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        edits: [{ model: 'Product', fields: [{ name: 'id', type: 'String', optional: false, isList: false, attrs: '@id' }] }],
      }),
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.assessment.risk).toBe('blocked');
    expect(typeof data.confirmToken).toBe('string');
  });

  it('apply 阻断级变更但无令牌：409 且磁盘不变', async () => {
    const before = fs.readFileSync(schemaFile(), 'utf8');
    const response = await request({
      port: handle!.port,
      path: '/api/schema/apply',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        edits: [{ model: 'Product', fields: [{ name: 'id', type: 'String', optional: false, isList: false, attrs: '@id' }] }],
      }),
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).error).toBe('confirm-required');
    expect(fs.readFileSync(schemaFile(), 'utf8')).toBe(before);
  });

  it('apply 带预览令牌：写盘成功并返回备份路径', async () => {
    const edits = [
      { model: 'Product', fields: [{ name: 'id', type: 'String', optional: false, isList: false, attrs: '@id' }] },
    ];
    const preview = await request({
      port: handle!.port,
      path: '/api/schema/preview',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ edits }),
    });
    const token = JSON.parse(preview.body).confirmToken;
    const response = await request({
      port: handle!.port,
      path: '/api/schema/apply',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ edits, confirmToken: token }),
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.ok).toBe(true);
    expect(data.risk).toBe('blocked');
    // 只断言 Product 少了字段：Category 也有 name，字符串匹配会误判
    const after = await request({ port: handle!.port, path: '/api/schema', headers: auth });
    const models = JSON.parse(after.body).models as { name: string; fields: { name: string }[] }[];
    expect(models.find((model) => model.name === 'Product')?.fields.map((field) => field.name)).toEqual(['id']);
  });

  it('apply 遇到非法 JSON：400 且磁盘不变', async () => {
    const before = fs.readFileSync(schemaFile(), 'utf8');
    const response = await request({
      port: handle!.port,
      path: '/api/schema/apply',
      method: 'POST',
      headers: auth,
      body: '{not json',
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid-edits');
    expect(fs.readFileSync(schemaFile(), 'utf8')).toBe(before);
  });

  it('preview 不接受 GET（405 并提示只接受 POST）', async () => {
    const response = await request({ port: handle!.port, path: '/api/schema/preview', headers: auth });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
  });
});

describe('Studio 前端产物托管', () => {
  let webDir: string;
  let staticHandle: StudioServerHandle | null = null;

  beforeEach(async () => {
    webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-studio-web-'));
    fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!DOCTYPE html><title>studio designer</title>', 'utf8');
    fs.writeFileSync(path.join(webDir, 'assets', 'app.js'), 'console.log(1)', 'utf8');
    // 产物目录外的敏感文件：用于验证目录穿越被挡
    fs.writeFileSync(path.join(path.dirname(webDir), 'secret.txt'), 'TOP-SECRET', 'utf8');
    staticHandle = await startStudioServer({
      projectRoot: tmpDir,
      port: 0,
      token: 'test-token',
      log: () => undefined,
      skipValidate: true,
      webDist: webDir,
      aiConfigFile: path.join(tmpDir, 'ai-config.json'),
    });
  });

  afterEach(async () => {
    await staticHandle?.close();
    staticHandle = null;
    fs.rmSync(webDir, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(webDir), 'secret.txt'), { force: true });
  });

  it('存在产物时首页返回前端页面而不是内置页', async () => {
    const response = await request({ port: staticHandle!.port, path: '/' });
    expect(response.status).toBe(200);
    expect(response.body).toContain('studio designer');
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('静态资源带正确 content-type', async () => {
    const response = await request({ port: staticHandle!.port, path: '/assets/app.js' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('javascript');
    expect(response.body).toBe('console.log(1)');
  });

  it('目录穿越被挡（assets/../secret.txt 拿不到产物外文件）', async () => {
    const response = await request({ port: staticHandle!.port, path: '/assets/../secret.txt' });
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('TOP-SECRET');
  });

  it('缺失的静态资源返回 404 并提示构建命令', async () => {
    const response = await request({ port: staticHandle!.port, path: '/assets/missing.js' });
    expect(response.status).toBe(404);
    expect(response.body).toContain('@fw/studio-web');
  });
});

describe('Studio 关系接口（S3）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };

  it('多对一：两端字段由服务端生成，返回可应用的 edits 与预览', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/schema/relation',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ from: 'Product', to: 'Category' }),
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.edits).toHaveLength(2);
    const product = data.edits.find((edit: { model: string }) => edit.model === 'Product');
    expect(product.fields.some((field: { name: string }) => field.name === 'categoryId')).toBe(true);
    expect(product.fields.find((field: { name: string }) => field.name === 'category').attrs).toContain('@relation');
    expect(data.assessment.risk).toBe('safe');
    expect(data.diff).toContain('categoryId');
    // 预览回显 edits：apply 必须用同一份，否则指纹对不上
    expect(Array.isArray(data.edits)).toBe(true);
  });

  it('自关联被拒绝（400）', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/schema/relation',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ from: 'Product', to: 'Product' }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).message).toContain('自关联');
  });

  it('缺 from / to 被拒绝（400）', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/schema/relation',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ from: 'Product' }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid-edits');
  });
});

describe('Studio 生成接口（S3）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };

  it('buildGenArgs：模型名与开关白名单拼接，不接受任意参数', () => {
    const { models, args } = buildGenArgs({ models: ['Product'], dry: true, noMigrate: true, noSeed: true });
    expect(models).toEqual(['Product']);
    expect(args).toEqual(['gen', 'crud', 'Product', '--dry', '--no-migrate', '--no-seed']);
    // --force（覆盖用户改过的产物）同样只能在显式 true 时出现
    expect(buildGenArgs({ models: ['A'], force: true }).args).toEqual(['gen', 'crud', 'A', '--force']);
    // 只有 true 才追加开关：false / 未传都不出现
    expect(buildGenArgs({ models: ['A'], dry: false }).args).toEqual(['gen', 'crud', 'A']);
  });

  it('buildGenArgs：非法模型名被拒（防参数注入）', () => {
    expect(() => buildGenArgs({ models: [] })).toThrow(/缺少 models/);
    expect(() => buildGenArgs({ models: ['Pro duct'] })).toThrow(/模型名不合法/);
    expect(() => buildGenArgs({ models: ['A; rm -rf /'] })).toThrow(/模型名不合法/);
    expect(() => buildGenArgs({ models: ['--dry'] })).toThrow(/模型名不合法/);
  });

  it('缺 models 时 POST /api/gen 返回 400', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/gen',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid-edits');
  });

  it('未知任务查询 404', async () => {
    const response = await request({ port: handle!.port, path: '/api/jobs/job-999', headers: auth });
    expect(response.status).toBe(404);
  });

  it('任务接口不接受 POST（405）', async () => {
    const response = await request({
      port: handle!.port,
      path: '/api/jobs/job-1',
      method: 'POST',
      headers: auth,
    });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET');
  });
});

describe('Studio 生成任务端到端（替身 CLI）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };
  let jobHandle: StudioServerHandle | null = null;
  let stubDir: string;

  beforeEach(async () => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-studio-stub-'));
    // 替身 CLI：把收到的参数打出来，按 STUB_EXIT 决定成败
    const stub = path.join(stubDir, 'stub-cli.mjs');
    fs.writeFileSync(
      stub,
      [
        'const args = process.argv.slice(2);',
        "console.log('[stub] args=' + args.join(' '));",
        "console.log('[stub] 已生成：demo.ts');",
        "if (process.env.STUB_FAIL === '1') { console.error('Error: 模拟失败'); process.exit(1); }",
        'process.exit(0);',
      ].join('\n'),
      'utf8',
    );
    jobHandle = await startStudioServer({
      projectRoot: tmpDir,
      port: 0,
      token: 'test-token',
      log: () => undefined,
      skipValidate: true,
      webDist: path.join(tmpDir, 'no-web-dist'),
      aiConfigFile: path.join(tmpDir, 'ai-config.json'),
      cliEntry: stub,
    });
  });

  afterEach(async () => {
    await jobHandle?.close();
    jobHandle = null;
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  /** 轮询任务直到结束 */
  const waitJob = async (jobId: string): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request({ port: jobHandle!.port, path: `/api/jobs/${jobId}`, headers: auth });
      const job = JSON.parse(response.body) as { status: string };
      if (job.status !== 'running') return job as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('任务超时未结束');
  };

  it('POST /api/gen 起任务，轮询到 succeeded 并带回输出', async () => {
    const started = await request({
      port: jobHandle!.port,
      path: '/api/gen',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ models: ['Product'], dry: true }),
    });
    expect(started.status).toBe(202);
    const { jobId } = JSON.parse(started.body) as { jobId: string };
    expect(jobId).toMatch(/^job-/);

    const job = await waitJob(jobId);
    expect(job.status).toBe('succeeded');
    expect(job.exitCode).toBe(0);
    const lines = job.lines as string[];
    // 参数被正确拼装并传给 CLI
    expect(lines[0]).toContain('gen crud Product --dry');
    expect(lines.join('\n')).toContain('已生成');
  });

  it('CLI 失败时任务记为 failed 并带上错误摘要', async () => {
    process.env.STUB_FAIL = '1';
    try {
      const started = await request({
        port: jobHandle!.port,
        path: '/api/gen',
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ models: ['Product'] }),
      });
      const { jobId } = JSON.parse(started.body) as { jobId: string };
      const job = await waitJob(jobId);
      expect(job.status).toBe('failed');
      expect(job.error).toContain('模拟失败');
    } finally {
      delete process.env.STUB_FAIL;
    }
  });
});

describe('Studio 生成物漂移（S4）', () => {
  const auth = { 'x-studio-token': 'test-token' };

  it('无清单时返回空列表且 tracked=false（不谎称安全）', async () => {
    const response = await request({ port: handle!.port, path: '/api/gen/drift', headers: auth });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.tracked).toBe(false);
    expect(data.models).toEqual([]);
  });

  it('有清单且文件被改过时如实报告 modified', async () => {
    const backend = path.join(tmpDir, 'apps', 'example-api');
    const artifact = path.join(tmpDir, 'apps/example-api/src/modules/product/product.service.ts');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, '// 用户改过的内容', 'utf8');
    fs.writeFileSync(
      path.join(backend, 'fw.gen.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            model: 'Product',
            kebab: 'product',
            modulePath: 'src/modules/product/product.module.ts',
            moduleClass: 'ProductModule',
            seedPath: 'prisma/seed/product.seed.ts',
            seedExport: 'seedProductPermissions',
            permissionCodes: ['product:read'],
            updatedAt: '2026-10-22',
            // 清单路径相对后端应用根（不是仓库根）：从应用目录或仓库根生成都同一口径
            files: [{ path: 'src/modules/product/product.service.ts', hash: 'stale-hash' }],
          },
        ],
      }),
      'utf8',
    );

    const response = await request({ port: handle!.port, path: '/api/gen/drift', headers: auth });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.tracked).toBe(true);
    expect(data.models[0].model).toBe('Product');
    expect(data.models[0].files[0].status).toBe('modified');
    expect(data.models[0].affected).toBe(1);
  });
});

describe('Studio AI 审查入口（S4 / FR-17-23）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };
  let reviewHandle: StudioServerHandle | null = null;
  let stubDir: string;
  const saved: Record<string, string | undefined> = {};

  /** 轮询任务直到结束 */
  const waitJob = async (jobId: string): Promise<{ status: string; lines: string[] }> => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request({ port: reviewHandle!.port, path: `/api/jobs/${jobId}`, headers: auth });
      const job = JSON.parse(response.body) as { status: string; lines: string[] };
      if (job.status !== 'running') return job;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error('任务超时');
  };

  beforeEach(async () => {
    for (const key of ['FW_AI_API_KEY', 'FW_AI_MODEL', 'FW_AI_BASE_URL', 'OPENAI_API_KEY']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-review-stub-'));
    const stub = path.join(stubDir, 'stub-cli.mjs');
    fs.writeFileSync(
      stub,
      [
        'const args = process.argv.slice(2);',
        "console.log('[stub] args=' + args.join(' '));",
        "console.log('[stub] 未发现问题');",
        'process.exit(0);',
      ].join('\n'),
      'utf8',
    );
    reviewHandle = await startStudioServer({
      projectRoot: tmpDir,
      port: 0,
      token: 'test-token',
      log: () => undefined,
      skipValidate: true,
      webDist: path.join(tmpDir, 'no-web-dist'),
      aiConfigFile: path.join(tmpDir, 'ai-config.json'),
      cliEntry: stub,
    });
  });

  afterEach(async () => {
    await reviewHandle?.close();
    reviewHandle = null;
    fs.rmSync(stubDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('未配置密钥时 GET 明确返回 configured=false（不回显密钥）', async () => {
    const response = await request({ port: reviewHandle!.port, path: '/api/review', headers: auth });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.configured).toBe(false);
    expect(response.body).not.toContain('apiKey');
  });

  it('未配置密钥时 POST 直接 400，而不是起一个注定失败的任务', async () => {
    const response = await request({
      port: reviewHandle!.port,
      path: '/api/review',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ models: ['Product'] }),
    });
    expect(response.status).toBe(400);
    const data = JSON.parse(response.body);
    expect(data.error).toBe('ai-not-configured');
    expect(data.message).toContain('FW_AI_API_KEY');
  });

  it('配置齐全时起 review 任务并把模型名透传给 CLI', async () => {
    process.env.FW_AI_API_KEY = 'sk-test';
    process.env.FW_AI_MODEL = 'review-model';
    const response = await request({
      port: reviewHandle!.port,
      path: '/api/review',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ models: ['Product'] }),
    });
    expect(response.status).toBe(202);
    const { jobId } = JSON.parse(response.body) as { jobId: string };
    const job = await waitJob(jobId);
    expect(job.status).toBe('succeeded');
    expect(job.lines.join('\n')).toContain('args=review Product');
  });

  it('模型名非法时 400（与生成接口同一道注入防线）', async () => {
    process.env.FW_AI_API_KEY = 'sk-test';
    process.env.FW_AI_MODEL = 'review-model';
    const response = await request({
      port: reviewHandle!.port,
      path: '/api/review',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ models: ['Product; rm -rf /'] }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid-edits');
  });

  it('GET 不是写接口：POST 之外的方法返回 405', async () => {
    const response = await request({
      port: reviewHandle!.port,
      path: '/api/review',
      method: 'DELETE',
      headers: auth,
    });
    expect(response.status).toBe(405);
  });
});

describe('Studio AI 建模入口（FR-17-24）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };
  let draftHandle: StudioServerHandle | null = null;
  const saved: Record<string, string | undefined> = {};

  /** 合法草案（与 docs/51 同构的最小版本） */
  const validDraft = {
    protocol_version: '1.0',
    status: 'draft',
    revision: 1,
    base_revision: 0,
    requirement_summary: '商品管理',
    models: [
      {
        name: 'Item',
        display_name: '条目',
        action: 'create',
        fields: [
          {
            name: 'name', display_name: '名称', type: 'String', nullable: false, default: null,
            unique: false, indexed: false, relation: null, source: 'explicit', destructive: false,
            ui: { visible_in_list: true, searchable: false, control: 'input', required: true },
          },
        ],
        indexes: [],
        relations: [],
      },
    ],
    assumptions: [], questions: [], warnings: [], unsupported_features: [], migration_risks: [],
    recommended_call_params: { temperature: 0.2, max_output_tokens: 4000, reason: '稳定' },
    generation_profile: { list_page_size: 20, default_sort: 'createdAt desc', permissions: ['item:read'], seed_count: 5 },
  };

  beforeEach(async () => {
    for (const key of ['FW_AI_API_KEY', 'FW_AI_MODEL', 'FW_AI_BASE_URL', 'OPENAI_API_KEY']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validDraft) } }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    draftHandle = await startStudioServer({
      projectRoot: tmpDir,
      port: 0,
      token: 'test-token',
      log: () => undefined,
      skipValidate: true,
      webDist: path.join(tmpDir, 'no-web-dist'),
      aiConfigFile: path.join(tmpDir, 'ai-config.json'),
      fetchImpl,
    });
  });

  afterEach(async () => {
    await draftHandle?.close();
    draftHandle = null;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('GET 返回上下文摘要与可用状态（不含 schema 全文）', async () => {
    const response = await request({ port: draftHandle!.port, path: '/api/model-draft', headers: auth });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.configured).toBe(false);
    expect(data.context.modelNames).toEqual(['Product', 'Category']);
    expect(response.body).not.toContain('datasource');
  });

  it('未配置密钥时 POST 400 ai-not-configured，不发起模型调用', async () => {
    const response = await request({
      port: draftHandle!.port,
      path: '/api/model-draft',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ requirement: '做商品管理' }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('ai-not-configured');
  });

  it('配置齐全时返回已校验草案与调用次数', async () => {
    process.env.FW_AI_API_KEY = 'sk-test';
    process.env.FW_AI_MODEL = 'draft-model';
    const response = await request({
      port: draftHandle!.port,
      path: '/api/model-draft',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ requirement: '做商品管理' }),
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.ok).toBe(true);
    expect(data.attempts).toBe(1);
    expect(data.draft.models[0].name).toBe('Item');
    expect(data.context.models).toBe(2);
  });

  it('缺 requirement 时 400', async () => {
    const response = await request({
      port: draftHandle!.port,
      path: '/api/model-draft',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid-edits');
  });

  it('DELETE 返回 405（该接口只读 + 生成一次）', async () => {
    const response = await request({
      port: draftHandle!.port,
      path: '/api/model-draft',
      method: 'DELETE',
      headers: auth,
    });
    expect(response.status).toBe(405);
  });
});

describe('Studio AI 路由配置（FR-17-25）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };
  let aiHandle: StudioServerHandle | null = null;
  let aiFile: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ['FW_AI_API_KEY', 'FW_AI_MODEL', 'FW_AI_BASE_URL', 'OPENAI_API_KEY']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    aiFile = path.join(tmpDir, 'ai-config.json');
    const fetchImpl = (async (url: string) =>
      String(url).endsWith('/models')
        ? new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 })) as unknown as typeof fetch;
    aiHandle = await startStudioServer({
      projectRoot: tmpDir,
      port: 0,
      token: 'test-token',
      log: () => undefined,
      skipValidate: true,
      webDist: path.join(tmpDir, 'no-web-dist'),
      aiConfigFile: aiFile,
      fetchImpl,
    });
  });

  afterEach(async () => {
    await aiHandle?.close();
    aiHandle = null;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('初始状态：未配置、来源 none、回配置文件路径但不含密钥', async () => {
    const response = await request({ port: aiHandle!.port, path: '/api/ai-config', headers: auth });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.configured).toBe(false);
    expect(data.source).toBe('none');
    expect(data.file).toBe(aiFile);
    // 只允许出现 apiKeySet 状态，不允许出现密钥字段本身
    expect(response.body).not.toMatch(/"apiKey"\s*:/);
    expect(response.body).not.toContain('sk-');
  });

  it('保存后立即可用：apiKeySet=true，且响应不回显密钥', async () => {
    const save = await request({
      port: aiHandle!.port,
      path: '/api/ai-config',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ baseUrl: 'https://ai.local/v1', model: 'm1', apiKey: 'sk-secret' }),
    });
    expect(save.status).toBe(200);
    expect(save.body).not.toContain('sk-secret');
    const data = JSON.parse(save.body);
    expect(data.configured).toBe(true);
    expect(data.apiKeySet).toBe(true);
    expect(data.source).toBe('file');

    // 页面保存即生效：建模接口的 configured 跟着变 true（无需重启）
    const draft = await request({ port: aiHandle!.port, path: '/api/model-draft', headers: auth });
    expect(JSON.parse(draft.body).configured).toBe(true);
  });

  it('留空密钥不覆盖已保存的值', async () => {
    await request({
      port: aiHandle!.port, path: '/api/ai-config', method: 'POST', headers: auth,
      body: JSON.stringify({ baseUrl: 'https://ai.local/v1', model: 'm1', apiKey: 'sk-keep' }),
    });
    const second = await request({
      port: aiHandle!.port, path: '/api/ai-config', method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'm2', apiKey: '' }),
    });
    const data = JSON.parse(second.body);
    expect(data.model).toBe('m2');
    expect(data.apiKeySet).toBe(true);
  });

  it('清除密钥后 configured 变 false', async () => {
    await request({
      port: aiHandle!.port, path: '/api/ai-config', method: 'POST', headers: auth,
      body: JSON.stringify({ baseUrl: 'https://ai.local/v1', model: 'm1', apiKey: 'sk-x' }),
    });
    const cleared = await request({
      port: aiHandle!.port, path: '/api/ai-config', method: 'POST', headers: auth,
      body: JSON.stringify({ clearApiKey: true }),
    });
    expect(JSON.parse(cleared.body).apiKeySet).toBe(false);
  });

  it('非法地址 400，不落盘', async () => {
    const response = await request({
      port: aiHandle!.port, path: '/api/ai-config', method: 'POST', headers: auth,
      body: JSON.stringify({ baseUrl: 'ftp://bad' }),
    });
    expect(response.status).toBe(400);
    expect(fs.existsSync(aiFile)).toBe(false);
  });

  it('测试连接走 /models 并返回可见模型数', async () => {
    const response = await request({
      port: aiHandle!.port, path: '/api/ai-config/test', method: 'POST', headers: auth,
      body: JSON.stringify({ baseUrl: 'https://ai.local/v1', apiKey: 'sk-test' }),
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.ok).toBe(true);
    expect(data.models).toBe(1);
  });

  it('空 body 保存 400（没有可保存字段）', async () => {
    const response = await request({
      port: aiHandle!.port, path: '/api/ai-config', method: 'POST', headers: auth, body: '{}',
    });
    expect(response.status).toBe(400);
  });

  it('DELETE 返回 405', async () => {
    const response = await request({
      port: aiHandle!.port, path: '/api/ai-config', method: 'DELETE', headers: auth,
    });
    expect(response.status).toBe(405);
  });
});

describe('Studio 模型列表（FR-17-25：模型名从 URL 取）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };
  let modelsHandle: StudioServerHandle | null = null;
  let modelsFile: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ['FW_AI_API_KEY', 'FW_AI_MODEL', 'FW_AI_BASE_URL', 'OPENAI_API_KEY']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    modelsFile = path.join(tmpDir, 'ai-models-config.json');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'probe-b' }, { id: 'probe-a' }] }), { status: 200 })) as unknown as typeof fetch;
    modelsHandle = await startStudioServer({
      projectRoot: tmpDir,
      port: 0,
      token: 'test-token',
      log: () => undefined,
      skipValidate: true,
      webDist: path.join(tmpDir, 'no-web-dist'),
      aiConfigFile: modelsFile,
      fetchImpl,
    });
  });

  afterEach(async () => {
    await modelsHandle?.close();
    modelsHandle = null;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('没填密钥时明确提示，而不是空列表冒充成功', async () => {
    const response = await request({
      port: modelsHandle!.port, path: '/api/ai-config/models', method: 'POST', headers: auth,
      body: JSON.stringify({ baseUrl: 'https://ai.local/v1' }),
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.ok).toBe(false);
    expect(data.models).toEqual([]);
    expect(data.message).toContain('密钥');
  });

  it('带密钥时返回模型名列表（失败也 200，用 ok 区分）', async () => {
    const response = await request({
      port: modelsHandle!.port, path: '/api/ai-config/models', method: 'POST', headers: auth,
      body: JSON.stringify({ baseUrl: 'https://ai.local/v1', apiKey: 'sk-test' }),
    });
    const data = JSON.parse(response.body);
    expect(data.ok).toBe(true);
    expect(data.models).toEqual(['probe-a', 'probe-b']);
    expect(response.body).not.toContain('sk-test');
  });

  it('已保存配置时可以不传参数直接取列表', async () => {
    await request({
      port: modelsHandle!.port, path: '/api/ai-config', method: 'POST', headers: auth,
      body: JSON.stringify({ baseUrl: 'https://ai.local/v1', model: 'probe-a', apiKey: 'sk-saved' }),
    });
    const response = await request({
      port: modelsHandle!.port, path: '/api/ai-config/models', method: 'POST', headers: auth, body: '{}',
    });
    expect(JSON.parse(response.body).models).toEqual(['probe-a', 'probe-b']);
  });

  it('诊断返回两步结果与完整对话地址（不泄露密钥）', async () => {
    const response = await request({
      port: modelsHandle!.port, path: '/api/ai-config/diagnose', method: 'POST', headers: auth,
      body: JSON.stringify({ baseUrl: 'https://ai.local/v1', apiKey: 'sk-diag', model: 'probe-a' }),
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.chatUrl).toBe('https://ai.local/v1/chat/completions');
    expect(data.steps).toHaveLength(2);
    expect(response.body).not.toContain('sk-diag');
  });

  it('未配置密钥时诊断直接说明，不发请求', async () => {
    const response = await request({
      port: modelsHandle!.port, path: '/api/ai-config/diagnose', method: 'POST', headers: auth, body: '{}',
    });
    const data = JSON.parse(response.body);
    expect(data.ok).toBe(false);
    expect(data.message).toContain('密钥');
  });

  it('GET 该方法返回 405（列表查询只接受 POST，避免密钥进 URL）', async () => {
    const response = await request({ port: modelsHandle!.port, path: '/api/ai-config/models', headers: auth });
    expect(response.status).toBe(405);
  });
});

describe('草案导入设计器（FR-17-24 第三步）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };
  let convertHandle: StudioServerHandle | null = null;

  beforeEach(async () => {
    convertHandle = await startStudioServer({
      projectRoot: tmpDir,
      port: 0,
      token: 'test-token',
      log: () => undefined,
      skipValidate: true,
      webDist: path.join(tmpDir, 'no-web-dist'),
      aiConfigFile: path.join(tmpDir, 'ai-convert.json'),
    });
  });

  afterEach(async () => {
    await convertHandle?.close();
    convertHandle = null;
  });

  const draft = {
    models: [
      {
        name: 'Tag',
        action: 'create',
        fields: [
          { name: 'name', type: 'String', nullable: false, default: null, unique: true, indexed: false, relation: null },
        ],
        indexes: [],
      },
    ],
    unsupported_features: [],
  };

  it('返回可装载的设计器模型（补 id、翻译 unique），且不写 schema', async () => {
    const before = fs.readFileSync(path.join(tmpDir, 'apps/example-api/prisma/schema.prisma'), 'utf8');
    const response = await request({
      port: convertHandle!.port,
      path: '/api/model-draft/to-editor',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ draft }),
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.models[0].name).toBe('Tag');
    expect(data.models[0].fields[0].name).toBe('id');
    expect(data.models[0].fields.find((field: { name: string }) => field.name === 'name').attrs).toBe('@unique');
    // 只读：schema 未被改动
    expect(fs.readFileSync(path.join(tmpDir, 'apps/example-api/prisma/schema.prisma'), 'utf8')).toBe(before);
  });

  it('缺 draft 时 400', async () => {
    const response = await request({
      port: convertHandle!.port,
      path: '/api/model-draft/to-editor',
      method: 'POST',
      headers: auth,
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid-edits');
  });
});

describe('草案缓存与增量修改（FR-17-24）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };
  let handle2: StudioServerHandle | null = null;
  let draftFile: string;
  const savedEnv: Record<string, string | undefined> = {};

  /** 模型返回的增量草案（只给 operations） */
  const reviseOutput = {
    protocol_version: '1.0',
    status: 'draft',
    revision: 2,
    base_revision: 1,
    requirement_summary: '给商品加颜色字段',
    operations: [
      {
        op: 'add_field',
        model: 'Product',
        reason: '需求要求颜色',
        field: {
          name: 'color', display_name: '颜色', type: 'String', nullable: true, default: null,
          unique: false, indexed: false, relation: null, source: 'explicit', destructive: false,
          ui: { visible_in_list: true, searchable: false, control: 'input', required: false },
        },
      },
    ],
    assumptions: [], questions: [], warnings: [], unsupported_features: [], migration_risks: [],
  };

  const currentDraft = {
    protocol_version: '1.0',
    status: 'draft',
    revision: 1,
    base_revision: 0,
    requirement_summary: '商品管理',
    models: [
      {
        name: 'Product',
        display_name: '商品',
        action: 'create',
        fields: [
          { name: 'name', display_name: '名称', type: 'String', nullable: false, default: null, unique: true, indexed: false, relation: null, source: 'explicit', destructive: false, ui: { visible_in_list: true, searchable: true, control: 'input', required: true } },
        ],
        indexes: [], relations: [],
      },
    ],
  };

  beforeEach(async () => {
    for (const key of ['FW_AI_API_KEY', 'FW_AI_MODEL', 'FW_AI_BASE_URL', 'OPENAI_API_KEY']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // 增量修改要真的调模型：用注入的 fetch 替身，仍需「看起来配好了」
    process.env.FW_AI_API_KEY = 'sk-test';
    process.env.FW_AI_MODEL = 'probe-model';
    draftFile = path.join(tmpDir, 'saved-draft.json');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reviseOutput) } }] }), { status: 200 })) as unknown as typeof fetch;
    handle2 = await startStudioServer({
      projectRoot: tmpDir,
      port: 0,
      token: 'test-token',
      log: () => undefined,
      skipValidate: true,
      webDist: path.join(tmpDir, 'no-web-dist'),
      aiConfigFile: path.join(tmpDir, 'ai-revise.json'),
      draftFile,
      fetchImpl,
    });
  });

  afterEach(async () => {
    await handle2?.close();
    handle2 = null;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('缓存写入后读回，清空后为空', async () => {
    const save = await request({
      port: handle2!.port, path: '/api/model-draft/saved', method: 'POST', headers: auth,
      body: JSON.stringify({ draft: currentDraft }),
    });
    expect(save.status).toBe(200);
    expect(JSON.parse(save.body).savedAt).toBeTruthy();

    const read = await request({ port: handle2!.port, path: '/api/model-draft/saved', headers: auth });
    expect(JSON.parse(read.body).saved.draft.revision).toBe(1);

    const clear = await request({
      port: handle2!.port, path: '/api/model-draft/saved/clear', method: 'POST', headers: auth,
    });
    expect(JSON.parse(clear.body).cleared).toBe(true);
    const after = await request({ port: handle2!.port, path: '/api/model-draft/saved', headers: auth });
    expect(JSON.parse(after.body).saved).toBeNull();
  });

  it('revise 返回应用后的新草案与字段级 diff', async () => {
    const response = await request({
      port: handle2!.port, path: '/api/model-draft/revise', method: 'POST', headers: auth,
      body: JSON.stringify({ draft: currentDraft, instruction: '商品需要颜色字段' }),
    });
    expect(response.status, response.body).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.draft.revision).toBe(2);
    expect(data.changes[0]).toMatchObject({ op: 'add_field', path: 'Product.color', destructive: false });
    expect(data.draft.models[0].fields.map((field: { name: string }) => field.name)).toContain('color');
    expect(data.destructive).toBe(false);
  });

  it('revise 缺指令或草案版本时 400', async () => {
    const noInstruction = await request({
      port: handle2!.port, path: '/api/model-draft/revise', method: 'POST', headers: auth,
      body: JSON.stringify({ draft: currentDraft }),
    });
    expect(noInstruction.status).toBe(400);

    const noRevision = await request({
      port: handle2!.port, path: '/api/model-draft/revise', method: 'POST', headers: auth,
      body: JSON.stringify({ draft: { ...currentDraft, revision: 'x' }, instruction: '加字段' }),
    });
    expect(noRevision.status).toBe(400);
  });
});


describe('buildReviewArgs 切分策略', () => {
  it('模型与 split 一起透传', () => {
    expect(buildReviewArgs({ models: ['Tag'], split: 'model' })).toEqual({
      models: ['Tag'],
      args: ['review', 'Tag', '--split=model'],
    });
  });

  it('非法 split 静默丢弃（不把脏参数交给 CLI）', () => {
    expect(buildReviewArgs({ models: ['Tag'], split: 'anything' }).args).toEqual(['review', 'Tag']);
  });

  it('省略 models 时审查全部，仍可带 split', () => {
    expect(buildReviewArgs({ split: 'file' })).toEqual({ models: [], args: ['review', '--split=file'] });
  });
});

describe('从 JSON 识别模型（FR-17-04 补充）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };
  let jsonHandle: StudioServerHandle | null = null;

  beforeEach(async () => {
    jsonHandle = await startStudioServer({
      projectRoot: tmpDir,
      port: 0,
      token: 'test-token',
      log: () => undefined,
      skipValidate: true,
      webDist: path.join(tmpDir, 'no-web-dist'),
      aiConfigFile: path.join(tmpDir, 'ai-json.json'),
    });
  });

  afterEach(async () => {
    await jsonHandle?.close();
    jsonHandle = null;
  });

  it('识别草案信封并补齐框架字段，但不写 schema', async () => {
    const schemaFile = path.join(tmpDir, 'apps/example-api/prisma/schema.prisma');
    const before = fs.readFileSync(schemaFile, 'utf8');
    const response = await request({
      port: jsonHandle!.port, path: '/api/schema/import-json', method: 'POST', headers: auth,
      body: JSON.stringify({
        json: JSON.stringify({
          models: [{ name: 'Tag', fields: [{ name: 'name', type: 'String', nullable: false, unique: true }] }],
        }),
      }),
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.models[0].name).toBe('Tag');
    expect(data.models[0].fields[0].name).toBe('id');
    expect(data.models[0].fields.some((field: { name: string }) => field.name === 'name')).toBe(true);
    expect(fs.readFileSync(schemaFile, 'utf8')).toBe(before);
  });

  it('语法错误返回 400 并说明原因', async () => {
    const response = await request({
      port: jsonHandle!.port, path: '/api/schema/import-json', method: 'POST', headers: auth,
      body: JSON.stringify({ json: '{oops' }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).message).toContain('JSON 语法错误');
  });

  it('缺 json 字段时 400', async () => {
    const response = await request({
      port: jsonHandle!.port, path: '/api/schema/import-json', method: 'POST', headers: auth, body: '{}',
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid-edits');
  });
});

describe('AI 补标注接口（FR-17-28 补充）', () => {
  const auth = { 'x-studio-token': 'test-token', 'content-type': 'application/json' };
  let handle3: StudioServerHandle | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ['FW_AI_API_KEY', 'FW_AI_MODEL', 'FW_AI_BASE_URL', 'OPENAI_API_KEY']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.FW_AI_API_KEY = 'sk-test';
    process.env.FW_AI_MODEL = 'probe-model';
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  models: [{ name: 'Product', label: '商品', fields: [{ name: 'name', label: '名称' }] }],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    handle3 = await startStudioServer({
      projectRoot: tmpDir,
      port: 0,
      token: 'test-token',
      log: () => undefined,
      skipValidate: true,
      webDist: path.join(tmpDir, 'no-web-dist'),
      aiConfigFile: path.join(tmpDir, 'ai-annotate.json'),
      fetchImpl,
    });
  });

  afterEach(async () => {
    await handle3?.close();
    handle3 = null;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('返回建议但不改 schema', async () => {
    const schemaFile = path.join(tmpDir, 'apps/example-api/prisma/schema.prisma');
    const before = fs.readFileSync(schemaFile, 'utf8');
    const response = await request({
      port: handle3!.port, path: '/api/schema/annotate', method: 'POST', headers: auth, body: '{}',
    });
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.ok).toBe(true);
    expect(data.suggestions.models).toEqual([{ name: 'Product', label: '商品' }]);
    expect(data.suggestions.fields).toEqual([{ model: 'Product', name: 'name', label: '名称' }]);
    expect(data.candidates.models).toBeGreaterThan(0);
    expect(fs.readFileSync(schemaFile, 'utf8')).toBe(before);
  });

  it('未配置模型时 400 ai-not-configured', async () => {
    process.env.FW_AI_API_KEY = '';
    process.env.FW_AI_MODEL = '';
    const response = await request({
      port: handle3!.port, path: '/api/schema/annotate', method: 'POST', headers: auth, body: '{}',
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('ai-not-configured');
  });
});

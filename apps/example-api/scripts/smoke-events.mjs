/**
 * @file M10 E-12 SSE 实时推送冒烟验证脚本
 * @description 单实例（TRANSPORT_DRIVER=in-process）形态下逐条验证统一 SSE 通道：
 *   A. 未登录取票 → 401 / 3001；
 *   B. 取票主题按权限裁剪：admin 得 ['job','queue']，alice 得 ['job']（反向验证越权面不开放）；
 *   C. 建流成功：响应头 text/event-stream + X-Accel-Buffering: no，并收到 `ready` 帧；
 *   D. 票据一次性：同一票据二次建流 → 401；
 *   E. 派发审计导出 → 事件流**不依赖轮询**即收到该任务的 job 事件（progress 与终态）；
 *   F. 归属人隔离：alice 的连接收不到 admin 的任务事件；
 *   G. 断连清理：关闭两条流后 `/demo-transport/stats` 的 events.topics 回落到 0（不留悬挂订阅）。
 *
 *   多副本跨实例扇出（TRANSPORT_DRIVER=redis）需真实 Redis，本机无 Redis 环境，
 *   该语义由 @fw/transport 单测（共享事件总线的双驱动实例）覆盖，真机复跑记录见发布报告。
 *   前置：dist 已构建；dev.db 已迁移并播种。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 冒烟专用端口（避开既有冒烟实例） */
const PORT = 3760;
const CWD = fileURLToPath(new URL('..', import.meta.url));
const DB_URL = `file:${path.join(CWD, 'prisma/dev.db')}`;

const results = [];

/** 记录并打印一项断言 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** HTTP 请求：返回 { status, body, text, headers } */
async function call(base, url, options) {
  const res = await fetch(base + url, options);
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, text, headers: res.headers };
}

/** 登录并返回 access token */
async function login(base, account, password) {
  const res = await call(base, '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  return res.body?.data?.accessToken ?? null;
}

/** 取票 */
async function ticket(base, token) {
  return call(base, '/api/v1/events/ticket', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

/** 解析一帧 SSE 文本（`event:` / `data:` 行） */
function parseFrame(chunk) {
  const event = { name: null, data: null };
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event.name = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      const raw = line.slice(5).trim();
      try {
        event.data = JSON.parse(raw);
      } catch {
        event.data = raw;
      }
    }
  }
  return event.name ? event : null;
}

/**
 * 打开 SSE 流并持续累积事件
 * @returns { res, frames, close }
 */
async function openStream(base, ticketValue, { withHeaders = false } = {}) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/v1/events/stream?ticket=${encodeURIComponent(ticketValue)}`, {
    signal: controller.signal,
  });
  const frames = [];
  if (res.status !== 200) {
    return { res, frames, headers: res.headers, close: () => controller.abort() };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const frame = parseFrame(chunk);
          if (frame) frames.push(frame);
        }
      }
    } catch {
      // 客户端 abort 或服务端断开：正常路径
    }
  })();
  return {
    res,
    frames,
    headers: res.headers,
    close: async () => {
      controller.abort();
      await Promise.race([pump, sleep(500)]);
    },
  };
}

/** 等待断言条件成立（支持同步 / 异步断言） */
async function waitFor(predicate, label, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
}

/** 启动应用实例 */
async function startInstance() {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: { ...process.env, APP_PORT: String(PORT), DB_URL, DB_DRIVER: 'sqlite', TRANSPORT_DRIVER: 'in-process' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  for (let i = 0; i < 60; i++) {
    try {
      const { status } = await call(`http://127.0.0.1:${PORT}`, '/ready');
      if (status === 200) return { child, output: () => output };
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`实例在 30s 内未就绪：\n${output.slice(-2000)}`);
}

async function main() {
  console.log('—— M10 E-12 SSE 实时推送冒烟（单实例 in-process 事件面） ——\n');
  const base = `http://127.0.0.1:${PORT}`;
  const instance = await startInstance();
  let adminStream = null;
  let aliceStream = null;
  try {
    const admin = await login(base, 'admin', 'Admin@123456');
    const alice = await login(base, 'alice', 'Alice@123456');
    const adminId = (await call(base, '/api/v1/auth/me', { headers: { authorization: `Bearer ${admin}` } })).body?.data?.id;

    // ---------- A. 未登录取票 ----------
    console.log('\n—— 阶段 A：未登录取票 ——');
    const anon = await ticket(base, '');
    check('未登录 POST /events/ticket → 401 / 3001',
      anon.status === 401 && anon.body?.code === 3001, `http=${anon.status} code=${anon.body?.code}`);

    // ---------- B. 主题按权限裁剪 ----------
    console.log('\n—— 阶段 B：票据主题按权限裁剪 ——');
    const adminTicket = await ticket(base, admin);
    check('admin 取票 → 200 且 topics = [job, notification, queue]',
      adminTicket.status === 200 &&
        JSON.stringify(adminTicket.body?.data?.topics ?? []) === JSON.stringify(['job', 'notification', 'queue']),
      `topics=${JSON.stringify(adminTicket.body?.data?.topics)}`);
    check('票据有效期 60s（一次性短凭证）',
      adminTicket.body?.data?.expiresIn === 60, `expiresIn=${adminTicket.body?.data?.expiresIn}`);

    const aliceTicket = await ticket(base, alice);
    check('alice（无 system:queue:list）取票 → topics = [job, notification]（越权面不开放）',
      JSON.stringify(aliceTicket.body?.data?.topics ?? []) === JSON.stringify(['job', 'notification']),
      `topics=${JSON.stringify(aliceTicket.body?.data?.topics)}`);

    // E-13：事件面存在**常驻基础订阅**（通知派发器订阅 job.progress / queue.alert），
    // 故「无 SSE 连接时主题数」不是 0——先取基线，阶段 G 的断连回归以它为判据
    const baselineStats = await call(base, '/api/v1/demo-transport/stats');
    const basicTopics = baselineStats.body?.data?.events?.topics ?? 0;
    check('事件面已有常驻基础订阅（通知派发器订阅 job / queue，E-13 起）',
      basicTopics >= 2, `topics=${basicTopics}`);

    // ---------- C. 建流 ----------
    console.log('\n—— 阶段 C：建流与 ready 帧 ——');
    adminStream = await openStream(base, adminTicket.body.data.ticket);
    await waitFor(() => adminStream.frames.some((f) => f.name === 'ready'), 'admin 收到 ready 帧');
    const ready = adminStream.frames.find((f) => f.name === 'ready');
    check('SSE 响应 Content-Type = text/event-stream',
      (adminStream.headers.get('content-type') ?? '').includes('text/event-stream'),
      String(adminStream.headers.get('content-type')));
    check('反代缓冲已显式关闭（X-Accel-Buffering: no）',
      (adminStream.headers.get('x-accel-buffering') ?? '').toLowerCase() === 'no',
      String(adminStream.headers.get('x-accel-buffering')));
    check('ready 帧携带可订阅主题',
      JSON.stringify(ready?.data?.topics ?? []) === JSON.stringify(['job', 'notification', 'queue']),
      `ready.topics=${JSON.stringify(ready?.data?.topics)}`);

    aliceStream = await openStream(base, aliceTicket.body.data.ticket);
    await waitFor(() => aliceStream.frames.some((f) => f.name === 'ready'), 'alice 收到 ready 帧');
    check('alice 连接建立但只有 job 主题（ready.topics=[job]）',
      JSON.stringify(aliceStream.frames.find((f) => f.name === 'ready')?.data?.topics ?? []) === JSON.stringify(['job', 'notification']));

    // ---------- D. 票据一次性 ----------
    console.log('\n—— 阶段 D：票据一次性 ——');
    const reused = await call(base, `/api/v1/events/stream?ticket=${encodeURIComponent(adminTicket.body.data.ticket)}`, {});
    check('已核销票据再次建流 → 401（取后即废）', reused.status === 401, `http=${reused.status}`);
    const bogus = await call(base, '/api/v1/events/stream?ticket=not-a-ticket', {});
    check('伪造票据建流 → 401', bogus.status === 401, `http=${bogus.status}`);

    // ---------- E. 事件推送（不经轮询） ----------
    console.log('\n—— 阶段 E：任务事件经 SSE 直达 ——');
    const adminJobFramesBefore = adminStream.frames.filter((f) => f.name === 'job').length;
    const dispatched = await call(base, '/api/v1/audit-logs/export', {
      headers: { authorization: `Bearer ${admin}` },
    });
    const jobId = dispatched.body?.data?.id;
    check('派发审计导出 → 200 且返回 jobId', dispatched.status === 200 && typeof jobId === 'string', `http=${dispatched.status}`);

    const startedAt = Date.now();
    await waitFor(
      () => adminStream.frames.some((f) => f.name === 'job' && f.data?.job?.id === jobId && f.data?.job?.status === 'succeeded'),
      'admin 流收到该任务终态事件',
    );
    const latency = Date.now() - startedAt;
    const jobFrames = adminStream.frames.filter((f) => f.name === 'job' && f.data?.job?.id === jobId);
    check('事件流收到该任务的 job 事件（不依赖轮询）',
      jobFrames.length >= 2 && adminStream.frames.length > adminJobFramesBefore,
      `frames=${jobFrames.length}`);
    check('事件携带完整任务视图（ownerId + filename 可下载）',
      jobFrames.at(-1)?.data?.ownerId === adminId && typeof jobFrames.at(-1)?.data?.job?.fileName === 'string',
      `ownerId=${jobFrames.at(-1)?.data?.ownerId} fileName=${jobFrames.at(-1)?.data?.job?.fileName}`);
    check('终态事件延迟在秒级内（轮询基准间隔为 1s）', latency < 2000, `latency=${latency}ms`);
    check('事件类型覆盖 created/progress/finished 中的多个阶段',
      new Set(jobFrames.map((f) => f.data?.kind)).size >= 2,
      `kinds=${JSON.stringify([...new Set(jobFrames.map((f) => f.data?.kind))])}`);

    // ---------- F. 归属人隔离 ----------
    console.log('\n—— 阶段 F：归属人隔离（反向验证） ——');
    await sleep(500);
    check('alice 的连接收不到 admin 的任务事件（服务端按归属人过滤）',
      aliceStream.frames.filter((f) => f.name === 'job').length === 0,
      `alice job frames=${aliceStream.frames.filter((f) => f.name === 'job').length}`);

    // ---------- G. 断连清理 ----------
    console.log('\n—— 阶段 G：断连释放订阅 ——');
    // E-13 起事件面有一个**常驻基础订阅**：通知派发器订阅 job.progress / queue.alert
    // （站内信由事件产生），故「无 SSE 连接时主题数」不是 0。断连回归判据改为「回到基础值」，
    // 而不是「归零」——后者会把常驻订阅误判为悬挂。
    const baseline = basicTopics;
    const before = await call(base, '/api/v1/demo-transport/stats');
    check('两条流在线时主题数高于基础值（SSE 追加了 notification 主题）',
      (before.body?.data?.events?.topics ?? 0) === baseline + 1,
      `topics=${before.body?.data?.events?.topics} baseline=${baseline}`);

    await adminStream.close();
    await aliceStream.close();
    adminStream = null;
    aliceStream = null;
    await waitFor(
      async () => ((await call(base, '/api/v1/demo-transport/stats')).body?.data?.events?.topics ?? -1) === baseline,
      '断连后订阅数回到基础值',
      6000,
    ).catch(() => false);
    const after = await call(base, '/api/v1/demo-transport/stats');
    check('两条流断开后主题数回到基础值（SSE 订阅已释放，无悬挂）',
      (after.body?.data?.events?.topics ?? -1) === baseline, `topics=${after.body?.data?.events?.topics} baseline=${baseline}`);
    check('事件面发布计数 ≥ 本次任务事件数（发布侧埋点生效）',
      (after.body?.data?.events?.published ?? 0) >= jobFrames.length,
      `published=${after.body?.data?.events?.published}`);
  } finally {
    await adminStream?.close();
    await aliceStream?.close();
    instance.child.kill();
    await sleep(500);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
